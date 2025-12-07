import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import fs from "fs/promises";
import path from "path";

// ==========================================
// 設定 (Configuration)
// ==========================================
const CONFIG = {
  MODEL_NAME: "gpt-5.1",
  TEMPERATURE: 0,
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 0,
  CONCURRENCY_LIMIT: 3,
  MAX_RETRIES: 3,
};

// ==========================================
// プロンプト管理 (Prompts)
// ==========================================
const PROMPTS = {
  DRAFT: ChatPromptTemplate.fromMessages([
    ["system", `You are a professional technical translator.
Translate the input text into Japanese strictly adhering to the following [Constraints].

[Constraints]
1. **Output Language**: Always output in Japanese.
2. **Keep English Terms**: Do not katakana-ize product names, codes, specific proper nouns, or technical terms (e.g., 'iPhone', 'Python', 'API') if the original English spelling is more natural for pronunciation or recognition. Keep them in English.
3. **Maintain Existing Japanese**: If parts of the input text are already in natural Japanese, keep them exactly as they are.
4. **TTS Optimization**: Translate for Text-To-Speech (TTS) purposes. Ensure the Japanese is audibly easy to understand with a natural rhythm. Break up sentences that are too long.
5. **No Superfluous Text**: Do not include explanations, notes, or conversational fillers. Output ONLY the translated text string.`],
    ["user", "{original_text}"]
  ]),

  CRITIQUE: ChatPromptTemplate.fromMessages([
    ["system", `You are a translation quality assurance specialist.
Compare the "Original Text" and the "Translation Draft", and list improvement points based on the following criteria.

[Check Criteria]
1. **Technical Terms**: Are technical terms or library names unnecessarily katakana-ized? (Keep them in English if that is more natural).
2. **TTS Suitability**: Is the rhythm poor when heard via TTS, or are sentences too long causing unnatural pauses?
3. **Accuracy & Naturalness**: Are there mistranslations? Has existing Japanese content been altered unnaturally?

If there are no issues, output only "No issues".`],
    ["user", "Original Text: {original_text}\n\nTranslation Draft: {initial_translation}"]
  ]),

  REFINE: ChatPromptTemplate.fromMessages([
    ["system", `You are a professional editor.
Create the **final translation** optimized for TTS based on the "Original Text", "Initial Translation", and "Critique".
If there are no critiques, output the initial translation as is.`],
    ["user", `Original Text: {original_text}
Initial Translation: {initial_translation}
Critique: {critique}`]
  ])
};

// ==========================================
// ユーティリティ
// ==========================================
async function withRetry(fn, retries = 3, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    console.error(`  ⚠️ エラー発生。リトライします (残り${retries}回): ${error.message}`);
    await new Promise(res => setTimeout(res, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

// 標準入力を読み込む関数
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");

    if (process.stdin.isTTY) {
      console.error("入力待機中... (Ctrl+D で送信完了)");
    }

    process.stdin.on("data", chunk => data += chunk);
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ==========================================
// クラス: 翻訳サービス
// ==========================================
class TranslationService {
  constructor() {
    this.model = new ChatOpenAI({
      modelName: CONFIG.MODEL_NAME,
      temperature: CONFIG.TEMPERATURE
    });
    this.chain = this._buildChain();
  }

  _buildChain() {
    return RunnableSequence.from([
      async (input) => {
        const initialTranslation = await PROMPTS.DRAFT
          .pipe(this.model)
          .pipe(new StringOutputParser())
          .invoke(input);
        return { ...input, initial_translation: initialTranslation };
      },
      async (input) => {
        const critique = await PROMPTS.CRITIQUE
          .pipe(this.model)
          .pipe(new StringOutputParser())
          .invoke(input);
        return { ...input, critique };
      },
      async (input) => {
        const prefix = input.chunk_id ? `[Chunk ${input.chunk_id}]` : "";
        let finalTranslation;
        const critiqueSnippet = input.critique.replace(/\n/g, " ").slice(0, 40);
        
        if (input.critique.includes("No issues") || input.critique.includes("問題なし")) {
          console.error(`  ${prefix} 査読: 問題なし (${critiqueSnippet}...)`);
          finalTranslation = await PROMPTS.REFINE
            .pipe(this.model)
            .pipe(new StringOutputParser())
            .invoke({ ...input, critique: "No changes needed." });
        } else {
          console.error(`  ${prefix} 査読: 指摘あり (${critiqueSnippet}...)`);
          finalTranslation = await PROMPTS.REFINE
            .pipe(this.model)
            .pipe(new StringOutputParser())
            .invoke(input);
        }

        return {
          draft: input.initial_translation,
          critique: input.critique,
          refine: finalTranslation
        };
      }
    ]);
  }

  async translateChunk(text, chunkIndex, totalChunks) {
    console.error(`Processing Chunk ${chunkIndex + 1}/${totalChunks}...`);
    return withRetry(async () => {
      const result = await this.chain.invoke({ 
        original_text: text,
        chunk_id: chunkIndex + 1
      });
      console.error(`  ✓ Chunk ${chunkIndex + 1} Done.`);
      return result;
    }, CONFIG.MAX_RETRIES);
  }
}

// ==========================================
// クラス: アプリケーション
// ==========================================
class App {
  constructor(inputText, debugDir) {
    this.inputText = inputText;
    this.debugDir = debugDir;
    this.translator = new TranslationService();
  }

  async run() {
    console.error(`=== 翻訳開始 (Input Length: ${this.inputText.length} chars) ===`);

    try {
      if (this.debugDir) {
        await fs.mkdir(this.debugDir, { recursive: true });
        console.error(`デバッグディレクトリ: ${this.debugDir}`);
      }
    } catch (e) {
      console.error("フォルダ作成警告:", e.message);
    }

    if (!this.inputText.trim()) {
      console.error("❌ エラー: 入力テキストが空です。");
      process.exit(1);
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CONFIG.CHUNK_SIZE,
      chunkOverlap: CONFIG.CHUNK_OVERLAP,
      separators: ["\n\n", "\n", ".", "。", "!", "！", "?", "？"],
    });
    const docs = await splitter.createDocuments([this.inputText]);
    console.error(`Total Chunks: ${docs.length}`);

    const results = [];
    for (let i = 0; i < docs.length; i++) results.push(null);

    for (let i = 0; i < docs.length; i += CONFIG.CONCURRENCY_LIMIT) {
      const batch = docs.slice(i, i + CONFIG.CONCURRENCY_LIMIT);
      
      await Promise.all(
        batch.map((doc, idx) => {
          const globalIndex = i + idx;
          return this.translator
            .translateChunk(doc.pageContent, globalIndex, docs.length)
            .then(async (res) => {
              results[globalIndex] = res;
              if (this.debugDir) {
                const chunkId = String(globalIndex + 1).padStart(3, "0");
                await fs.writeFile(path.join(this.debugDir, `chunk_${chunkId}_refine.txt`), res.refine, "utf-8");
              }
            })
            .catch((err) => {
              console.error(`❌ Chunk ${globalIndex + 1} Error:`, err.message);
              results[globalIndex] = { refine: `[Error]` };
            });
        })
      );
    }

    const fullFinal = results.map((r) => r.refine).join("\n\n");
    console.log(fullFinal);
    console.error(`\n=== 完了 ===`);
  }
}

// ==========================================
// エントリーポイント
// ==========================================
(async () => {
  const debugDir = process.argv[2] || "outputs/work_translate";

  try {
    const inputText = await readStdin();
    const app = new App(inputText, debugDir);
    await app.run();
  } catch (err) {
    console.error("予期せぬエラー:", err);
    process.exit(1);
  }
})();