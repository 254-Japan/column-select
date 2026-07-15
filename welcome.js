const LANG = (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';

const MSG = {
  ja: {
    title: 'Column Select へようこそ！',
    subtitle: 'ブラウザ上のテキストを「縦」に選択できるようになりました',
    step1Title: 'Alt を押しながらドラッグ',
    step1Body: 'メール本文や入力欄の上で、Alt キーを押しながらマウスをドラッグしてください。矩形（長方形）にテキストを選択できます。キーボード派は Alt + Ctrl + 矢印キーでもOK。',
    step2Title: '選択したら、このキーが使えます',
    keyCopy: '選択した列をコピー',
    keyCut: '選択した列をカット（削除してコピー）',
    keyPaste: 'クリップボードの内容を全行に同時ペースト',
    keyReplace: '選択範囲内だけを対象に置換',
    keyTypeLabel: '文字入力',
    keyType: '全行に同じ文字を同時入力',
    keyUndo: '元に戻す',
    keyEsc: '選択を解除',
    step3Title: 'ここで今すぐ試せます',
    step3Body: '下のボックスで Alt + ドラッグしてみてください。「>」の列だけ選択して Ctrl+X で削除、など試し放題です。',
    tryText: '> お世話になっております。\n> 先日の件、ありがとうございました。\n> 来週の打ち合わせもよろしくお願いします。\n> 佐藤',
    footer: 'Gmail・Yahoo!メール・Webフォームなど、ほとんどの入力欄で動作します。',
  },
  en: {
    title: 'Welcome to Column Select!',
    subtitle: 'You can now select text vertically — right in your browser',
    step1Title: 'Hold Alt and drag',
    step1Body: 'Hold the Alt key and drag your mouse over an email body or text field to select a rectangular block of text. Prefer the keyboard? Alt + Ctrl + Arrow keys works too.',
    step2Title: 'Once selected, use these keys',
    keyCopy: 'Copy the selected columns',
    keyCut: 'Cut the selected columns',
    keyPaste: 'Paste clipboard text into every selected row at once',
    keyReplace: 'Find & replace within the selection only',
    keyTypeLabel: 'Type any character',
    keyType: 'Insert the same text into every row simultaneously',
    keyUndo: 'Undo',
    keyEsc: 'Clear the selection',
    step3Title: 'Try it right here',
    step3Body: 'Alt + drag inside the box below. For example, select just the ">" column and press Ctrl+X to strip quote marks from every line.',
    tryText: '> Thanks for your email.\n> The meeting is confirmed for Monday.\n> Looking forward to seeing you.\n> Sam',
    footer: 'Works in Gmail, Yahoo Mail, web forms, and most text fields.',
  },
};

document.title = 'Column Select — ' + (LANG === 'ja' ? 'ようこそ' : 'Welcome');
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = MSG[LANG][el.dataset.i18n] || '';
}
document.querySelector('.try-area').value = MSG[LANG].tryText;
