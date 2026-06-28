import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin, QueryClient } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";

import App from "./App.vue";
import "./assets/scss/main.scss";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // données fraîches 30s
      gcTime: 5 * 60_000, // cache 5min
      retry: 1,
    },
  },
});

const app = createApp(App);

app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
app.use(PrimeVue, {
  theme: {
    preset: "none",
    options: {
      darkModeSelector: ".dark",
      cssLayer: false,
    },
  },
});

app.mount("#app");
