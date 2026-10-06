import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { isValidSlug } from './store/runlog.ts';
import { EXIT_CODES } from './types.ts';
import type { ExitCode, RunState } from './types.ts';

export const USAGE = `사용법: agent-workflow <명령> [인자] [--workspace <path>]
명령: doctor [--deep] [--json]
      run --mode plan|full|wiki [--request-file <p>] [--parallel] [--name <slug>] [--since <ref>]
      resume <run-id> [--answer <text>] [--lane <id>] [--grant network|full] [--mode full]
      status <run-id> [--view current|timeline|decisions|plan|todo|qa] [--json]
      logs <run-id> [--seq <N>] [--json]
      list [--json]
      watch <run-id>
      cleanup <run-id> | --finished [--force]
      qa-runtime setup [--slots <1..32>] [--base-port <1..65535>]`;
type Common = { workspace: string };
export type CommandLine = Common & (
  | {
    command: 'doctor';
    deep: boolean;
    json: boolean
  }
  | {
    command: 'run';
    mode: RunState['mode'];
    requestFile?: string;
    parallel: boolean;
    name: string;
    since?: string
  }
  | {
    command: 'resume';
    runId: string;
    answer?: string;
    lane?: string;
    grant?: 'network' | 'full';
    mode?: 'full'
  }
  | {
    command: 'status';
    runId: string;
    view: 'current' | 'timeline' | 'decisions' | 'plan' | 'todo' | 'qa';
    json: boolean
  }
  | {
    command: 'logs';
    runId: string;
    seq?: number;
    json: boolean
  }
  | {
    command: 'list';
    json: boolean
  }
  | {
    command: 'watch';
    runId: string
  }
  | {
    command: 'cleanup';
    runId?: string;
    finished: boolean;
    force: boolean
  }
  | {
    command: 'qa-runtime setup';
    slots: number;
    basePort: number
  }
);
export type ParseResult = ({ ok: true } & CommandLine) | {
  ok: false;
  error: string
};
const commandOptions: Record<string, Record<string, 'string' | 'boolean'>> = {
  doctor: { deep: 'boolean', json: 'boolean' },
  run: {
    mode: 'string', 'request-file': 'string', parallel: 'boolean', name: 'string', since: 'string'
  },
  resume: { answer: 'string', lane: 'string', grant: 'string', mode: 'string' },
  status: { view: 'string', json: 'boolean' },
  logs: { seq: 'string', json: 'boolean' },
  list: { json: 'boolean' },
  watch: {},
  cleanup: { finished: 'boolean', force: 'boolean' },
  'qa-runtime setup': { slots: 'string', 'base-port': 'string' },
};
function fail(message: string): never {
  throw new Error(message);
}
function integer(value: string | undefined, option: string, fallback?: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    fail(`${option}은 1~${max} 정수여야 합니다.`);
  }
  return n;
}
export function parseCommandLine(argv: string[]): ParseResult {
  try {
    let command = argv[0];
    let args = argv.slice(1);
    if (command === 'qa-runtime') {
      if (args[0] !== 'setup') fail('qa-runtime에는 setup 하위 명령이 필요합니다.');
      command = 'qa-runtime setup';
      args = args.slice(1);
    }
    if (!Object.hasOwn(commandOptions, command ?? '')) fail(`명령이 없거나 알 수 없습니다.\n${USAGE}`);
    const options = Object.fromEntries(
      Object.entries({ workspace: 'string', ...commandOptions[command] }).map(
        ([key, type]) => [key, { type: type as 'string' | 'boolean' }],
      ),
    );
    const { values, positionals } = parseArgs({ args, options, strict: true, allowPositionals: true });
    const str = (key: string): string | undefined => values[key] as string | undefined;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && !value.trim()) fail(`--${key} 값은 빈 문자열일 수 없습니다.`);
    }
    const common = { workspace: resolve(str('workspace') ?? process.cwd()) };
    const one = () => {
      if (positionals.length !== 1 || !positionals[0]) fail('run-id 위치 인자가 정확히 1개 필요합니다.');
      return positionals[0];
    };
    const none = () => {
      if (positionals.length) fail('위치 인자는 허용되지 않습니다.');
    };
    const choice = (key: string, allowed: readonly string[], fallback?: string) => {
      const value = str(key) ?? fallback;
      if (value === undefined || !allowed.includes(value)) fail(`--${key} 값은 ${allowed.join('|')} 중 하나여야 합니다.`);
      return value;
    };
    switch (command) {
      case 'doctor':
        none();
        return { ok: true, command, ...common, deep: !!values.deep, json: !!values.json };
      case 'run': {
        none();
        const mode = choice('mode', ['plan', 'full', 'wiki']) as RunState['mode'];
        if (mode !== 'wiki' && !str('request-file')) fail('--request-file이 필요합니다.');
        if (mode === 'wiki' && values.parallel !== undefined) fail('wiki 모드에는 --parallel을 사용할 수 없습니다.');
        if (mode === 'wiki' && !str('since')) fail('wiki 모드에는 --since가 필요합니다.');
        if (mode !== 'wiki' && str('since') !== undefined) fail('--since는 wiki 모드에서만 허용됩니다.');
        const name = str('name') ?? 'run';
        if (!isValidSlug(name)) fail('--name은 소문자 영문, 숫자, 하이픈만 허용합니다.');
        return {
          ok: true,
          command,
          ...common,
          mode,
          requestFile: str('request-file'),
          parallel: !!values.parallel,
          name,
          since: str('since'),
        };
      }
      case 'resume': {
        const runId = one();
        const grant = str('grant') === undefined
          ? undefined : choice('grant', ['network', 'full']) as 'network' | 'full';
        const mode = str('mode') === undefined ? undefined : choice('mode', ['full']) as 'full';
        return { ok: true, command, ...common, runId, answer: str('answer'), lane: str('lane'), grant, mode };
      }
      case 'status':
        return {
          ok: true,
          command,
          ...common,
          runId: one(),
          view: choice(
            'view', ['current', 'timeline', 'decisions', 'plan', 'todo', 'qa'], 'current',
          ) as Extract<CommandLine, { command: 'status' }>['view'],
          json: !!values.json,
        };
      case 'logs':
        return {
          ok: true,
          command,
          ...common,
          runId: one(),
          seq: str('seq') === undefined ? undefined : integer(str('seq'), '--seq'),
          json: !!values.json,
        };
      case 'list':
        none();
        return { ok: true, command, ...common, json: !!values.json };
      case 'watch':
        return { ok: true, command, ...common, runId: one() };
      case 'cleanup':
        if (positionals.length > 1 || (positionals.length === 1) === !!values.finished) {
          fail('run-id 1개와 --finished 중 정확히 하나가 필요합니다.');
        }
        return {
          ok: true, command, ...common, runId: positionals[0], finished: !!values.finished, force: !!values.force,
        };
      case 'qa-runtime setup':
        none();
        return {
          ok: true,
          command,
          ...common,
          slots: integer(str('slots'), '--slots', 4, 32),
          basePort: integer(str('base-port'), '--base-port', 4100, 65535),
        };
      default:
        return fail('알 수 없는 명령입니다.');
    }
  } catch (error) {
    return {
      ok: false, error: `인자 오류: ${(error as Error).message}`
    };
  }
}
const handlers: Partial<Record<CommandLine['command'], (command: CommandLine) => Promise<ExitCode>>> = {};
export async function main(argv: string[]): Promise<ExitCode> {
  const parsed = parseCommandLine(argv);
  if (!parsed.ok) {
    console.error(parsed.error.includes(USAGE) ? parsed.error : `${parsed.error}\n${USAGE}`);
    return EXIT_CODES.USAGE;
  }
  const handler = handlers[parsed.command];
  if (!handler) {
    console.error(`아직 구현되지 않은 명령입니다: ${parsed.command}`);
    return EXIT_CODES.USAGE;
  }
  return handler(parsed);
}
