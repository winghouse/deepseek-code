# 发布流程

## 版本号规范

```
shared / core / cli 三包同步版本号
格式: 主版本.次版本.修订版本 (0.5.0)
```

## 发布前检查清单

- [ ] `pnpm build` — 三包编译无错误
- [ ] `pnpm test` — 全部测试通过 (330+)
- [ ] `pnpm test:eval` — 路由评测通过 (40)
- [ ] CHANGELOG.md 已更新
- [ ] README.md 版本号/功能描述已更新
- [ ] `git status` — 无未提交改动

## 发布到 GitHub

```bash
# 1. 提交所有改动
git add -A
git commit -m "vX.Y.Z: 版本描述"

# 2. 推送
git push origin master

# 3. 创建 Release Tag
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 发布到 npm

```bash
# 1. 确保已登录
npm whoami

# 2. 编译
pnpm build

# 3. 按依赖顺序发布 (shared → core → cli)
cd packages/shared && npm publish --access public
cd ../core && npm publish --access public
cd ../cli && npm publish --access public
```

## 一键发布脚本

```bash
# release.sh
set -e
echo "=== 编译 ===" && pnpm build
echo "=== 测试 ===" && pnpm test
echo "=== 评测 ===" && pnpm test:eval
echo "=== Git ===" && git add -A && git commit -m "v$1" && git push
echo "=== npm ===" && cd packages/shared && npm publish --access public && cd ../core && npm publish --access public && cd ../cli && npm publish --access public
echo "✅ v$1 发布完成"
```

## 版本历史

| 版本 | 日期 | 核心变更 |
|------|------|---------|
| v0.5.0 | 2026-06-10 | 质量加固：模型名常量、executor拆分、+47测试、/write命令 |
| v0.4.0 | 2026-06-10 | 首次公开发布：npm + GitHub + Docker |
