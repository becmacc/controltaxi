import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (!id.includes('node_modules')) return undefined;

              if (id.includes('/firebase/app') || id.includes('/@firebase/app')) return 'firebase-app';
              if (id.includes('/firebase/auth') || id.includes('/@firebase/auth')) return 'firebase-auth';
              if (id.includes('/firebase/firestore') || id.includes('/@firebase/firestore')) return 'firebase-firestore';
              if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase-core';
              if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react-vendor';
              if (id.includes('/react-router-dom/') || id.includes('/react-router/') || id.includes('/@remix-run/')) return 'router-vendor';
              if (id.includes('/lucide-react/')) return 'ui-icons';
              if (id.includes('/date-fns/')) return 'date-utils';

              return 'vendor-misc';
            },
          },
        },
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
