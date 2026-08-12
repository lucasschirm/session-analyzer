import './pages/app-root';

const root = document.getElementById('app');
if (root) {
  root.replaceChildren(document.createElement('app-root'));
}
