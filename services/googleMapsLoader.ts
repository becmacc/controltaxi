
declare global {
  interface Window {
    google?: any;
    initMap?: () => void;
  }
}

let isLoading = false;
let isLoaded = false;
const callbacks: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

export const loadGoogleMapsScript = (apiKey: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (isLoaded) {
      resolve();
      return;
    }

    // 1. Check if already fully loaded
    if (window.google && window.google.maps && window.google.maps.Map && window.google.maps.marker && window.google.maps.visualization) {
      isLoaded = true;
      resolve();
      return;
    }

    // 2. Queue if loading
    if (isLoading) {
      callbacks.push({ resolve, reject });
      return;
    }

    if (!apiKey) {
      reject(new Error("API Key is missing"));
      return;
    }

    isLoading = true;

    // 3. Define the global callback that Google will call
    window.initMap = () => {
      isLoading = false;
      isLoaded = true;
      resolve();
      // Notify any other pending calls
      callbacks.forEach(cb => cb.resolve());
      callbacks.length = 0;
      // Cleanup global callback
      delete window.initMap;
    };

    // 4. Create and inject script with callback and loading=async
    // CRITICAL: Added 'visualization' to libraries for heatmap support
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker,visualization&callback=initMap&loading=async&v=weekly`;
    script.async = true;
    script.defer = true;
    
    script.onerror = () => {
      isLoading = false;
      const error = new Error("Failed to load Google Maps script. Check your API key and internet connection.");
      reject(error);
      callbacks.forEach(cb => cb.reject(error));
      callbacks.length = 0;
      delete window.initMap;
    };

    document.head.appendChild(script);
  });
};
