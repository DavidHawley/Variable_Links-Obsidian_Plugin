import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/main.ts',
  // These are supplied by Obsidian. Keeping them external ensures our editor
  // extension uses the same CodeMirror instance as the active editor.
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    sourcemap: true,
    inlineDynamicImports: true
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.json' })
  ]
};
