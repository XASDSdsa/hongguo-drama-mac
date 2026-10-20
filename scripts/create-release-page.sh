#!/usr/bin/env bash
# 打包机上新建发布页（已经有了就什么都不做）。用法：create-release-page.sh <tag> <标题> <说明>
#
# GitHub 不允许打包机（GITHUB_TOKEN，没有 workflows 权限）给 .github/workflows 和 main 分支不一样的提交打标签，
# 直接 gh release create --target <本次提交> 会被拒（HTTP 403 Resource not accessible by integration）。
# 所以标签打在一个专门的发布提交上：软件代码和本次打包的提交完全一样，只有 .github/workflows 换成 main 分支的。
# Windows 和 Mac 同时打包时可能都来新建：谁先建好都行，另一个直接用。
set -euo pipefail
tag="$1"
title="$2"
notes="$3"
repo="${GITHUB_REPOSITORY:?}"
sha="${GITHUB_SHA:?}"

if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo "release page $tag already exists"
  exit 0
fi

if ! git ls-remote --exit-code origin "refs/tags/$tag" >/dev/null 2>&1; then
  git fetch -q --depth=1 origin main
  export GIT_INDEX_FILE="${RUNNER_TEMP:-/tmp}/release-index"
  rm -f "$GIT_INDEX_FILE"
  git read-tree "$sha"
  git rm -rq --cached --ignore-unmatch .github/workflows
  for f in $(git ls-tree -r --name-only FETCH_HEAD .github/workflows/); do
    git update-index --add --cacheinfo "100644,$(git rev-parse "FETCH_HEAD:$f"),$f"
  done
  tree=$(git write-tree)
  unset GIT_INDEX_FILE
  release_commit=$(
    GIT_AUTHOR_NAME=github-actions GIT_AUTHOR_EMAIL=41898282+github-actions[bot]@users.noreply.github.com \
      GIT_COMMITTER_NAME=github-actions GIT_COMMITTER_EMAIL=41898282+github-actions[bot]@users.noreply.github.com \
      git commit-tree "$tree" -p "$sha" -m "${title} 发布标签（软件代码同 ${sha:0:7}，workflow 文件同 main）"
  )
  # 另一个系统的打包可能刚好先打了这个标签：失败了就看标签是不是已经有了。
  git push origin "$release_commit:refs/tags/$tag" ||
    git ls-remote --exit-code origin "refs/tags/$tag" >/dev/null
fi

gh release create "$tag" --repo "$repo" --verify-tag --prerelease --title "$title" --notes "$notes" ||
  gh release view "$tag" --repo "$repo" >/dev/null
