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
  
  // 修正箇所: --debug-dir または -d を検知するように変更
  const debugIndex = args.findIndex(arg => arg === '--debug-dir' || arg === '-d');
  let debugDir = null;
  
  if (debugIndex !== -1 && args[debugIndex + 1]) {
    debugDir = args[debugIndex + 1];
    // 引数リストからフラグとパスを除去（残りをテキスト入力とみなすため）
    args.splice(debugIndex, 2);
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
    if (debugDir) {
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      // 1. 原文の保存
      fs.writeFileSync(path.join(debugDir, '01_input_text.txt'), inputText);
      // 2. システムプロンプトの保存
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
      // 3. 翻訳結果の保存
      fs.writeFileSync(path.join(debugDir, '03_output_text.txt'), translatedText);
      
      // 4. メタデータの保存
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