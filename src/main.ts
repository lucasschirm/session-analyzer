import './pages/app-root';
import './components/dashboard-components';

// Register custom elements
import { AppRoot } from './pages/app-root';
import { MetricsCard, SessionList, EventsTable, ProjectSelector } from './components/dashboard-components';

// Ensure elements are defined
if (!customElements.get('app-root')) {
  customElements.define('app-root', AppRoot);
}

// Dashboard components are auto-registered via decorators
console.log('Session Analyzer initialized');
