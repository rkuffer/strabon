/// <reference types="vite/client" />

// Déclaration ambiante des SFC Vue.
//
// `tsc` seul ne sait pas lire un fichier .vue : sans ce shim, tout
// `import App from "./App.vue"` échoue en TS2307. Ce fichier est déjà référencé
// par l'`include` du tsconfig de web — il manquait simplement au dépôt.
//
// Attention à ce que ce shim fait et NE fait pas : il permet à `tsc` de résoudre
// les imports de SFC, mais il en type le contenu de façon opaque. La vraie
// vérification du TYPE à l'intérieur des composants (props, emits, templates)
// est faite par `vue-tsc`, que `npm run build -w @strabon/web` exécute déjà.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
