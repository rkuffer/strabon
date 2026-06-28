// packages/web/src/admin.ts
// Point d'entrée de la SPA Vue admin.
// Monté sur #admin-preview-app dans les pages Eta qui en ont besoin.

import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import AdminPreviewApp from "./components/admin/AdminPreviewApp.vue";
import "./assets/scss/main.scss";

const el = document.getElementById("admin-preview-app");
if (el) {
  const app = createApp(AdminPreviewApp, {
    siteId:      el.dataset.siteId ?? "",
    siteTitle:   el.dataset.siteTitle ?? "",
    hasExisting: el.dataset.hasExisting === "true",
  });
  app.use(createPinia());
  app.use(PrimeVue, { theme: "none" });
  app.mount(el);
}
