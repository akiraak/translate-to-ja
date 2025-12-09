#!/usr/bin/env node

require('dotenv').config();
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

// ==========================================
// 設定
// ==========================================
const CONFIG = {
  MODEL: 'gpt-5',
  SYSTEM_PROMPT: `
You are a professional translator. 
Translate the following text into natural, fluent Japanese.
Maintain the tone and nuance of the original text.
Output ONLY the translated Japanese text.
`.trim(),
};

// ==========================================
// メイン処理
// ==========================================
(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // --- 引数解析 ---
  const args = process.argv.slice(2);
  
  // --out または -o の後の値を取得
  const outIndex = args.findIndex(arg => arg === '--out' || arg === '-o');
  let debugDir = null;
  
  if (outIndex !== -1 && args[outIndex + 1]) {
    debugDir = args[outIndex + 1];
    // 引数リストから --out 関連を除去（残りをテキストとみなすため）
    args.splice(outIndex, 2);
  }

  // --- 入力テキストの取得 (Stdin or Args) ---
  let inputText = args.join(' ').trim();

  // 引数がなければ標準入力を待つ
  if (!inputText) {
    inputText = await getStdin();
  }

  if (!inputText) {
    console.error('Error: No input text provided.');
    process.exit(1);
  }

  try {
    // --- デバッグ: ディレクトリ作成 ---
    if (debugDir && !fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // --- デバッグ: 入力テキスト保存 ---
    if (debugDir) {
      fs.writeFileSync(path.join(debugDir, '01_input_text.txt'), inputText);
      fs.writeFileSync(path.join(debugDir, '02_system_prompt.txt'), CONFIG.SYSTEM_PROMPT);
    }

    // --- API呼び出し ---
    const completion = await openai.chat.completions.create({
      model: CONFIG.MODEL,
      messages: [
        { role: 'system', content: CONFIG.SYSTEM_PROMPT },
        { role: 'user', content: inputText },
      ],
    });

    const translatedText = completion.choices[0].message.content.trim();

    // --- デバッグ: 結果保存 ---
    if (debugDir) {
      fs.writeFileSync(path.join(debugDir, '03_output_text.txt'), translatedText);
      
      // メタデータ（トークン使用量など）も保存しておくと便利
      const metaData = {
        model: completion.model,
        usage: completion.usage,
        created: new Date().toISOString()
      };
      fs.writeFileSync(path.join(debugDir, '04_meta.json'), JSON.stringify(metaData, null, 2));
    }

    // 標準出力へ (次のパイプへ渡すため)
    console.log(translatedText);

  } catch (error) {
    console.error('Translation Error:', error.message);
    process.exit(1);
  }
})();

// 標準入力を読み取るヘルパー関数
function getStdin() {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    
    if (stdin.isTTY) {
      resolve('');
      return;
    }

    stdin.setEncoding('utf8');
    stdin.on('data', chunk => data += chunk);
    stdin.on('end', () => resolve(data.trim()));
    stdin.on('error', () => resolve(''));
  });
}