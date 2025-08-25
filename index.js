// Background script for Smart Zetamac Coach extension

// Initialize Firebase API key in storage on extension install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('Extension installed, setting up Firebase configuration...');
    
    // Check if API key is already stored
    const result = await chrome.storage.local.get(['firebase_apiKey']);
    
    if (!result.firebase_apiKey) {
      // For now, we'll need to manually set this or read from environment
      // In a production build, this would be injected during build process
      console.warn('Firebase API key not found in storage. Extension may not work properly.');
      console.log('Please set the Firebase API key using the setup process.');
    }
  }
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getFirebaseConfig') {
    // Return Firebase configuration from storage
    chrome.storage.local.get(['firebase_apiKey']).then(result => {
      sendResponse({ apiKey: result.firebase_apiKey });
    });
    return true; // Keep the message channel open for async response
  }
}); 