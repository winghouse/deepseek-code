#!/bin/bash
set -e

VERSION=${1:?"用法: ./scripts/release.sh <版本号, 如 0.5.4>"}

echo "=== 1. 编译 ==="
pnpm build

echo "=== 2. 测试 ==="
pnpm test

echo "=== 3. 评测 ==="
pnpm test:eval

echo "=== 4. 替换 workspace:* → ^$VERSION ==="
for pkg in packages/cli/package.json packages/core/package.json; do
  sed -i "s/\"workspace:\*\"/\"^$VERSION\"/g" "$pkg"
done
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/shared/package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/core/package.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/cli/package.json

echo "=== 5. 发布 shared → core → cli ==="
cd packages/shared && npm publish --access public
cd ../core && npm publish --access public
cd ../cli && npm publish --access public
cd ../..

echo "=== 6. 回退 workspace:* ==="
for pkg in packages/cli/package.json packages/core/package.json; do
  sed -i "s/\"^$VERSION\"/\"workspace:*\"/g" "$pkg"
done

echo "=== 7. Git 提交 + 推送 ==="
git add packages/*/package.json
git commit -m "release: v$VERSION"
git push
git tag "v$VERSION"
git push origin "v$VERSION"

echo ""
echo "✅ v$VERSION 发布完成"
echo "   安装: npm i -g deepseek-codecli@$VERSION"
