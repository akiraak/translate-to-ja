#!/usr/bin/env node

// ログ抑制ハック
const originalLog = console.log;
console.log = () => {}; 
require('dotenv').config();
console.log = originalLog;

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');

// LangChain Imports
const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
  MODEL_NAME: 'gpt-5',
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 0, // 翻訳重複を避けるため0推奨
  CONCURRENCY_LIMIT: 4,
};

// ==========================================
// プロンプト定義 (Template)
// ==========================================
const SYSTEM_PROMPTS = {
  DRAFT: `You are a professional technical translator.
Translate the input text into Japanese strictly adhering to the following [Constraints].

[Constraints]
1. **Output Language**: Always output in Japanese.
2. **Keep English Terms**: Do not katakana-ize product names, codes, specific proper nouns, or technical terms.
3. **Maintain Existing Japanese**: Keep existing natural Japanese as is.
4. **TTS Optimization**: Translate for Text-To-Speech (TTS). Ensure natural rhythm and audible clarity.
5. **No Superfluous Text**: Output ONLY the translated text string.`,

  CRITIQUE: `You are a translation quality assurance specialist.
Compare the "Original Text" and the "Translation Draft", and list improvement points based on:
1. **Technical Terms**: Are terms unnecessarily katakana-ized?
2. **TTS Suitability**: Is the rhythm poor or sentences too long?
3. **Accuracy & Naturalness**: Any mistranslations?

If there are no issues, output only "No issues".`,

  REFINE: `You are a professional editor.
Create the **final translation** optimized for TTS based on the input.
If the critique says "No issues", output the initial translation as is.
Output ONLY the final Japanese text.`
};

// ==========================================
// メイン処理
// ==========================================
const program = new Command();

program
  .name('translate-cli-lc')
  .description('Translate text using LangChain (Split -> Draft -> Critique -> Refine)')
  .version('2.0.0')
  .argument('[text...]', 'Input text')
  .option('-d, --debug-dir <path>', 'Directory to save debug files')
  .action(async (textArgs, options) => {
    // 入力処理
    let inputText = textArgs.join(' ').trim();
    if (!inputText) inputText = await getStdin();
    if (!inputText) {
      console.error('Error: No input text provided.');
      process.exit(1);
    }

    const debugDir = options.debugDir;
    if (debugDir && !fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

    try {
      // 1. モデルとパーサーの初期化
      const model = new ChatOpenAI({ 
        modelName: CONFIG.MODEL_NAME, 
        apiKey: process.env.OPENAI_API_KEY
      });
      const parser = new StringOutputParser();

      // 2. テキスト分割
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: CONFIG.CHUNK_SIZE,
        chunkOverlap: CONFIG.CHUNK_OVERLAP,
        // 以下の順序で分割を試みます（上にあるものほど優先）
        separators: [
            "\n\n",  // 1. 段落（最も強く分割したい）
            "\n",    // 2. 改行
            ". ",    // 3. 英語の文末（". "とスペース付きにすると "Node.js" 等の誤分割を防げます）
            "? ", 
            "! ",
            ".", "?", "!", // 4. スペースなしの英語文末（念のため）
            "。", "！", "？", // 5. 日本語の文末
            " ",     // 6. 単語の区切り（英語では超重要。単語の途中で切れるのを防ぐ）
            ""       // 7. 最終手段（文字単位）
        ], 
      });
      
      const docs = await splitter.createDocuments([inputText]);
      const chunks = docs.map(d => d.pageContent);

      console.error(`>> Total Length: ${inputText.length} chars. Split into ${chunks.length} chunks.`);

      // 3. 各Chainの定義 (LCEL)
      const draftChain = ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_PROMPTS.DRAFT],
        ["human", "{text}"]
      ]).pipe(model).pipe(parser);

      const critiqueChain = ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_PROMPTS.CRITIQUE],
        ["human", "Original Text:\n{original}\n\nTranslation Draft:\n{draft}"]
      ]).pipe(model).pipe(parser);

      const refineChain = ChatPromptTemplate.fromMessages([
        ["system", SYSTEM_PROMPTS.REFINE],
        ["human", "Original Text:\n{original}\nInitial Translation:\n{draft}\nCritique:\n{critique}"]
      ]).pipe(model).pipe(parser);

      // 4. 並列実行処理 (各チャンクごとにChainを実行)
      const results = await runWithConcurrency(chunks, CONFIG.CONCURRENCY_LIMIT, async (chunkText, index) => {
        const prefix = `[Chunk ${index + 1}/${chunks.length}]`;
        const log = (msg) => console.error(`${prefix} ${msg}`);
        const debugPrefix = (index + 1).toString().padStart(3, '0');

        // --- Step 1: Draft ---
        log('Drafting...');
        const draftText = await draftChain.invoke({ text: chunkText });

        // --- Step 2: Critique ---
        log('Critiquing...');
        const critiqueText = await critiqueChain.invoke({ original: chunkText, draft: draftText });

        // --- Step 3: Refine ---
        let finalText = "";
        if (critiqueText.toLowerCase().includes("no issues") || critiqueText.includes("問題なし")) {
          log('Refine skipped (No issues).');
          finalText = draftText;
        } else {
          log('Refining...');
          finalText = await refineChain.invoke({ 
            original: chunkText, 
            draft: draftText, 
            critique: critiqueText 
          });
        }

        // デバッグ保存
        if (debugDir) {
          fs.writeFileSync(path.join(debugDir, `${debugPrefix}_01_input.txt`), chunkText);
          fs.writeFileSync(path.join(debugDir, `${debugPrefix}_02_draft.txt`), draftText);
          fs.writeFileSync(path.join(debugDir, `${debugPrefix}_03_critique.txt`), critiqueText);
          fs.writeFileSync(path.join(debugDir, `${debugPrefix}_04_final.txt`), finalText);
        }

        return finalText;
      });

      // 5. 結合して出力
      const finalOutput = results.join('\n\n');
      console.log(finalOutput);

      if (debugDir) {
        fs.writeFileSync(path.join(debugDir, 'full_output.txt'), finalOutput);
      }

    } catch (error) {
      console.error('Fatal Error:', error);
      process.exit(1);
    }
  });

program.parse(process.argv);

// ==========================================
// ユーティリティ
// ==========================================

async function getStdin() {
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

// 並列実行制御 (LangChainの.batch()は進行状況ログが出しにくいため、従来の制御方式を採用)
async function runWithConcurrency(tasks, limit, asyncFn) {
  const results = new Array(tasks.length);
  const executing = [];
  let index = 0;

  const enqueue = async () => {
    if (index === tasks.length) return;
    const i = index++;
    const p = asyncFn(tasks[i], i).then(res => { results[i] = res; });
    executing.push(p);
    p.then(() => executing.splice(executing.indexOf(p), 1));
    if (executing.length >= limit) await Promise.race(executing);
    await enqueue();
  };

  const workers = [];
  for (let j = 0; j < limit && j < tasks.length; j++) workers.push(enqueue());
  await Promise.all(workers);
  await Promise.all(executing);
  return results;
}