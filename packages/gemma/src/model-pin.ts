// Model pin for the local Gemma provider. The HMRC ingestion workflow's model
// cache key is hashFiles() of THIS file, so any edit here rolls the 2GB CI
// cache — keep it to the pin alone, and bump revision + sha256 together.

// Pinned to litert-community/gemma-4-E2B-it-litert-lm@main as of 2026-07-20
// (file lfs oid below).
export const MODEL_REVISION = '9262660a1676eed6d0c477ab1a86344430854664';
export const DEFAULT_MODEL_URL = `https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/${MODEL_REVISION}/gemma-4-E2B-it-web.litertlm`;
export const DEFAULT_MODEL_SHA256 =
  '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5';
