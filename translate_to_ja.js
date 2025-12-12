#!/usr/bin/env node

require('dotenv').config();
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
  MODEL: 'gpt-4o', 
  TEMPERATURE: 0,
};

// ==========================================
// プロンプト定義
// ==========================================
const PROMPTS = {
  DRAFT_SYSTEM: `You are a professional technical translator.
Translate the input text into Japanese strictly adhering to the following [Constraints].

[Constraints]
1. **Output Language**: Always output in Japanese.
2. **Keep English Terms**: Do not katakana-ize product names, codes, specific proper nouns, or technical terms (e.g., 'iPhone', 'Python', 'API') if the original English spelling is more natural for pronunciation or recognition. Keep them in English.
3. **Maintain Existing Japanese**: If parts of the input text are already in natural Japanese, keep them exactly as they are.
4. **TTS Optimization**: Translate for Text-To-Speech (TTS) purposes. Ensure the Japanese is audibly easy to understand with a natural rhythm. Break up sentences that are too long.
5. **No Superfluous Text**: Do not include explanations, notes, or conversational fillers. Output ONLY the translated text string.`,

  CRITIQUE_SYSTEM: `You are a translation quality assurance specialist.
Compare the "Original Text" and the "Translation Draft", and list improvement points based on the following criteria.

[Check Criteria]
1. **Technical Terms**: Are technical terms or library names unnecessarily katakana-ized? (Keep them in English if that is more natural).
2. **TTS Suitability**: Is the rhythm poor when heard via TTS, or are sentences too long causing unnatural pauses?
3. **Accuracy & Naturalness**: Are there mistranslations? Has existing Japanese content been altered unnaturally?

If there are no issues, output only "No issues".`,

  REFINE_SYSTEM: `You are a professional editor.
Create the **final translation** optimized for TTS based on the "Original Text", "Initial Translation", and "Critique".
If the critique says "No issues", output the initial translation as is.
Output ONLY the final Japanese text.`
};

// ==========================================
// メイン処理
// ==========================================
(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const args = process.argv.slice(2);
  const debugIndex = args.findIndex(arg => arg === '--debug-dir' || arg === '-d');
  let debugDir = null;
  
  if (debugIndex !== -1 && args[debugIndex + 1]) {
    debugDir = args[debugIndex + 1];
    args.splice(debugIndex, 2);
  }

  let inputText = args.join(' ').trim();
  if (!inputText) inputText = await getStdin();

  if (!inputText) {
    console.error('Error: No input text provided.');
    process.exit(1);
  }

  try {
    if (debugDir && !fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // ==========================================
    // Step 1: Draft (下訳)
    // ==========================================
    console.error('>> 1/3 Draft (下訳作成中)...'); // 進捗表示
    
    const draftCompletion = await openai.chat.completions.create({
      model: CONFIG.MODEL,
      temperature: CONFIG.TEMPERATURE,
      messages: [
        { role: 'system', content: PROMPTS.DRAFT_SYSTEM },
        { role: 'user', content: inputText },
      ],
    });
    const draftText = draftCompletion.choices[0].message.content.trim();

    // ==========================================
    // Step 2: Critique (査読)
    // ==========================================
    console.error('>> 2/3 Critique (AI査読中)...');

    const critiqueCompletion = await openai.chat.completions.create({
      model: CONFIG.MODEL,
      temperature: CONFIG.TEMPERATURE,
      messages: [
        { role: 'system', content: PROMPTS.CRITIQUE_SYSTEM },
        { role: 'user', content: `Original Text: ${inputText}\n\nTranslation Draft: ${draftText}` },
      ],
    });
    const critiqueText = critiqueCompletion.choices[0].message.content.trim();

    // ★★★ 変更点: 査読内容をコンソールに見やすく表示 ★★★
    console.error('\n--- [AI査読レポート] -----------------');
    console.error(critiqueText);
    console.error('--------------------------------------\n');

    // ==========================================
    // Step 3: Refine (推敲)
    // ==========================================
    let finalText = "";

    if (critiqueText.includes("No issues") || critiqueText.includes("問題なし")) {
      console.error('>> 3/3 Refine: 指摘がないためスキップしました。');
      finalText = draftText;
    } else {
      console.error('>> 3/3 Refine (推敲による修正中)...');
      const refineCompletion = await openai.chat.completions.create({
        model: CONFIG.MODEL,
        temperature: CONFIG.TEMPERATURE,
        messages: [
          { role: 'system', content: PROMPTS.REFINE_SYSTEM },
          { role: 'user', content: `Original Text: ${inputText}\nInitial Translation: ${draftText}\nCritique: ${critiqueText}` },
        ],
      });
      finalText = refineCompletion.choices[0].message.content.trim();
    }

    // --- デバッグ保存 ---
    if (debugDir) {
      fs.writeFileSync(path.join(debugDir, '01_input.txt'), inputText);
      fs.writeFileSync(path.join(debugDir, '02_draft.txt'), draftText);
      fs.writeFileSync(path.join(debugDir, '03_critique.txt'), critiqueText);
      fs.writeFileSync(path.join(debugDir, '04_final.txt'), finalText);
    }

    // --- 最終出力 (標準出力) ---
    console.log(finalText);

  } catch (error) {
    console.error('Translation Error:', error.message);
    process.exit(1);
  }
})();

// ヘルパー関数
function getStdin() {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    if (stdin.isTTY) { resolve(''); return; }
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => data += chunk);
    stdin.on('end', () => resolve(data.trim()));
    stdin.on('error', () => resolve(''));
  });
}