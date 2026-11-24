// Checagem barata antes do deploy: pega variavel nao definida, chave repetida,
// reatribuicao de const etc. — o tipo de erro que so aparece quando o codigo roda.
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'archive/**', 'auth_info*/**', 'backups/**', 'audios/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-redeclare': 'error',
      'no-unsafe-finally': 'error',
      'no-invalid-regexp': 'error',
    },
  },
];
