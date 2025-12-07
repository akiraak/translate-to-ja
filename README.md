# translate-to-ja
テキストを日本語に翻訳する

## 準備

```sh
echo "OPENAI_API_KEY=sk-..." > .env
```

## 実行コマンド

```sh
node translate_to_ja.mjs
入力待機中... (Ctrl+D で送信完了)

echo "Hello" | node translate_to_ja.mjs

cat input.txt | node translate_to_ja.mjs
```