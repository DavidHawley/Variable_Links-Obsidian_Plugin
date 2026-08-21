import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/main.ts',
  external: ['obsidian'], // don't bundle the obsidian runtime
  output: {
    dir: 'dist',
    format: 'cjs',
    sourcemap: true
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.json' })
  ]
};
