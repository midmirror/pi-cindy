/**
 * Conventional Commits 校验（本地 husky + CI 双闸）。
 * 项目历史 subject 用中文描述（可混英文术语），关闭 subject-case 避免误伤。
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],
    "header-max-length": [1, "always", 100],
    "body-max-line-length": [1, "always", 100],
  },
};
