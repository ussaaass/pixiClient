import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

/**
 * 共享规则。
 *
 * 分级约定：
 * - error：确定性缺陷（类型逃逸、var、隐式相等），CI 直接拦截；
 * - warn：风格与规范性问题，先提示不拦截，随代码演进逐步收紧为 error。
 *
 * 当前 CI 的 lint 范围是 packages / games / apps/server（新建与重构代码为主），
 * apps/web 与 apps/admin 通过 `pnpm lint:apps` 单独检查，不阻断流水线。
 */
const sharedRules = {
  'no-var': 'error',
  'no-undef': 'off',
  'no-unused-vars': 'off',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
  // Pixi 画布文案用全角空格做视觉间隔，属于有意为之；模板字符串内的不规则空白不视为缺陷。
  'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
  'eqeqeq': ['warn', 'smart'],
  'prefer-const': 'warn',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/.workbuddy-ai/**',
      'assets/**',
      'tools/asset-generation/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 只启用 essential（正确性规则），不启用 recommended/strongly-recommended。
  // 后者包含 max-attributes-per-line、html-indent、singleline-html-element-content-newline
  // 等纯排版规则，在存量 Vue 模板上会产生数千条无信息量的告警，
  // 且与 Prettier 的职责重叠。排版统一交给 Prettier，lint 只负责"对不对"。
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.ts', '**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    rules: sharedRules,
  },
  {
    // Vue 模板里的中文文案按中文排版惯例使用全角空格 U+3000 做视觉间隔，
    // 属于有意为之的排版字符而非复制粘贴产生的隐形字符。
    // ESLint 10 的 no-irregular-whitespace 不支持按字符豁免，故在 .vue 内整体关闭，
    // 保留在 .ts/.js 上的检查（那里更容易混入真正的隐形空白）。
    files: ['**/*.vue'],
    rules: {
      'no-irregular-whitespace': 'off',
    },
  },
];
