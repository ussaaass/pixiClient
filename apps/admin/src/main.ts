import { createApp } from 'vue';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/option/style/css';
import App from './App.vue';
import { createAdminRouter } from './router';
import './style.css';

const app = createApp(App);
app.use(createAdminRouter());
app.mount('#app');
