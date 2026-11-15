import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {loadMarsDem} from './data/marsDem';

// Load the real NASA MOLA elevation grids before anything samples terrain (about 21 MB total).
// If it fails, the app keeps working on its procedural fallback terrain.
loadMarsDem().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
