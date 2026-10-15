import { createApp } from 'vue';
import App from './App.vue';
import { createAdminRouter } from './router';
import './style.css';

const app = createApp(App);
app.use(createAdminRouter());
app.mount('#app');
