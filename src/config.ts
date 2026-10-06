import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { Role, WorkspaceConfig } from './types.ts';

const schema = JSON.parse(await readFile(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
type ConfigInput = Partial<Omit<WorkspaceConfig, 'roles' | 'limits' | 'app'>> & {
  roles?: Partial<Record<Role, Partial<WorkspaceConfig['roles'][Role]>>>;
  limits?: Partial<WorkspaceConfig['limits']>;
  app?: (Omit<NonNullable<WorkspaceConfig['app']>, 'startTimeoutSec'> & { startTimeoutSec?: number }) | null;
};
export async function loadConfig(workspace: string): Promise<{
  config: WorkspaceConfig;
  found: boolean
}> {
  let input: ConfigInput = {};
  let found = true;
  let text: string | undefined;
  try {
    text = await readFile(join(workspace, 'agent-workflow.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    found = false;
  }
  if (text !== undefined) {
    try {
      input = JSON.parse(text);
    }
    catch (error) {
      throw new Error(`설정 JSON 문법 오류: ${(error as Error).message}`);
    }
    if (!validate(input)) throw new Error(`설정 스키마 위반: ${ajv.errorsText(validate.errors)}`);
  }
  const roles = {} as WorkspaceConfig['roles'];
  for (const role of [
    'planningAuthor', 'planningReviewer', 'devAuthor', 'devReviewer', 'qa', 'wikiAuthor', 'wikiReviewer',
  ] as const) {
    roles[role] = {
      client: role.endsWith('Author') ? 'codex' : 'claude', model: null, effort: null, ...input.roles?.[role]
    };
  }
  return {
    found, config: {
      setupCommand: input.setupCommand ?? null, testCommand: input.testCommand ?? null,
      app: input.app ? { startTimeoutSec: 90, ...input.app } : null,
      wikiDir: input.wikiDir ?? 'docs/wiki', roles,
      limits: {
        maxReviewRounds: 5, sameIssueLimit: 2, maxQaRollbacks: 3, maxLanes: 3, stepTimeoutMin: 45, ...input.limits
      },
    }
  };
}
