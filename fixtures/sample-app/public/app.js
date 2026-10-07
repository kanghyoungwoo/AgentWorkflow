import { addMemo } from './memo.js';
let memos = [];
const input = document.querySelector('#memo-input');
const list = document.querySelector('#memo-list');
document.querySelector('#memo-form').addEventListener('submit', event => {
  event.preventDefault();
  memos = addMemo(memos, input.value);
  list.replaceChildren(...memos.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  input.value = '';
});
