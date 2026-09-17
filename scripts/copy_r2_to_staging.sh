#!/bin/bash
# staging 灌数据工具：把生产 R2（shumap-assets，只读）的对象逐-key 拷贝到
# shumap-assets-staging。key 清单从 D1 dump 提取（media_assets.object_key +
# releases.artifact_key），见 docs/staging.md。
#
# 用法：bash scripts/copy_r2_to_staging.sh <keys 文件>
#
# 注意必须用 --file 中转，不能用 --pipe 直连：wrangler 4.95 在非 TTY 下会把
# "Cloudflare agent skills are available..." 横幅打进 stdout，--pipe 会把它
# 写进对象（2026-09-17 实测每个对象被污染 +176B，worker 校验 byte_size 直接 500）。
set -u
export CLOUDFLARE_ACCOUNT_ID=400623ade20e6d96cb546c98bcf3e33f
KEYS_FILE="${1:?用法: bash scripts/copy_r2_to_staging.sh <keys 文件>}"
WORKDIR="tmp/staging/r2-files"
mkdir -p "$WORKDIR"
copy_one() {
  key="$1"
  safe=$(echo "$key" | tr '/' '_')
  dst="${WORKDIR}/${safe}"
  if npx wrangler r2 object get "shumap-assets/${key}" --remote --file "$dst" >/dev/null 2>&1 \
     && npx wrangler r2 object put "shumap-assets-staging/${key}" --remote --file "$dst" >/dev/null 2>&1; then
    echo "OK ${key}"
  else
    echo "FAIL ${key}"
  fi
}
export -f copy_one
xargs -P 4 -I {} bash -c 'copy_one "$@"' _ {} < "$KEYS_FILE"
