console.log("Popup loaded");

// Import Firebase Functions
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { firebaseConfig } from '../config/firebase-config.js';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app);

async function createAnonymousUser(forceRefresh = false) {
  try {
    const storage = await chrome.storage.local.get(['authToken', 'userId']);
    
    // if we have auth data and not forcing refresh, check if token is valid
    if (storage.authToken && storage.userId && !forceRefresh) {
      console.log("User already authenticated, checking token validity");
      
      // test the token with a quick firestore request
      const testResponse = await fetch(
        'https://firestore.googleapis.com/v1/projects/smart-zetamac-coach/databases/(default)/documents/sessions?pageSize=1',
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${storage.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (testResponse.ok) {
        console.log("Existing token is valid");
        return storage;
      } else {
        console.log("Token expired, refreshing...");
      }
    }

    console.log(forceRefresh ? "Force refreshing auth token" : "Creating new anonymous user");
    
    // for token refresh, try to use the existing refresh token first
    if (forceRefresh && storage.refreshToken) {
      console.log("Attempting to refresh existing token...");
      try {
        const { getFirebaseApiKey } = await import('../config/firebase-config.js');
        const apiKey = await getFirebaseApiKey();
        
        if (!apiKey) {
          console.error("Firebase API key not available");
          throw new Error("API key not available");
        }
        
        const refreshResponse = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: storage.refreshToken
          })
        });
        
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          const tokenData = {
            authToken: refreshData.access_token,
            refreshToken: refreshData.refresh_token,
            userId: storage.userId
          };
          
          await chrome.storage.local.set(tokenData);
          console.log("Token refreshed successfully for existing user:", storage.userId);
          return tokenData;
        } else {
          console.log("Refresh token expired, creating new anonymous user");
        }
      } catch (error) {
        console.log("Token refresh failed, creating new anonymous user:", error);
      }
    }
    
    // create new anonymous user if refresh failed or first time
    const { getFirebaseApiKey } = await import('../config/firebase-config.js');
    const apiKey = await getFirebaseApiKey();
    
    if (!apiKey) {
      console.error("Firebase API key not available");
      return null;
    }
    
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        returnSecureToken: true
      })
    });
    
    const data = await response.json();
    if (data.localId) {
      console.log("Anonymous user created:", data.localId);
      
      const tokenData = {
        authToken: data.idToken,
        userId: data.localId
      };
      
      await chrome.storage.local.set(tokenData);
      console.log("Auth token stored");
      return tokenData;
    } else {
      console.error("Anonymous auth failed:", data);
      return null;
    }
  } catch (error) {
    console.error("Anonymous auth failed:", error);
    return null;
  }
}

async function getRecentSessions() {
  try {
    let storage = await chrome.storage.local.get(['authToken', 'userId']);
    
    if (!storage.authToken || !storage.userId) {
      return [];
    }

    let response = await fetch(
      `https://firestore.googleapis.com/v1/projects/smart-zetamac-coach/databases/(default)/documents/sessions`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${storage.authToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // if 401, create new anonymous user
    if (response.status === 401) {
      console.log("Token expired in getRecentSessions, creating new anonymous user...");
      const newAuth = await createAnonymousUser(true);
      if (!newAuth) {
        console.error("Failed to create new anonymous user");
        return [];
      }
      
      // retry with new token
      response = await fetch(
        `https://firestore.googleapis.com/v1/projects/smart-zetamac-coach/databases/(default)/documents/sessions`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${newAuth.authToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // update storage reference for filtering
      storage = newAuth;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch sessions: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.documents) {
      return [];
    }

    return data.documents
      .filter(doc => doc.fields.userId?.stringValue === storage.userId)
      .map(doc => ({
        timestamp: new Date(doc.fields.timestamp.timestampValue),
        score: parseInt(doc.fields.score.integerValue),
        problems: doc.fields.problems?.arrayValue?.values?.map(p => ({
          question: p.mapValue.fields.question.stringValue,
          latency: parseInt(p.mapValue.fields.latency.integerValue)
        })) || []
      }));
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return [];
  }
}

// NEW: Use Firebase Functions to get comprehensive stats
async function getUserStatsFromFunctions() {
  try {
    // Ensure we have valid authentication
    const storage = await createAnonymousUser();
    if (!storage) {
      throw new Error("Failed to authenticate user");
    }

    // Sign in with Firebase Auth to get proper token for Functions
    await signInAnonymously(auth);

    // Call the Firebase Function
    const getUserStats = httpsCallable(functions, 'getUserStats');
    const result = await getUserStats({});
    
    return result.data;
  } catch (error) {
    console.error('Error getting user stats from Functions:', error);
    
    // Fallback to direct Firestore access
    const sessions = await getRecentSessions();
    return analyzeQuickStats(sessions);
  }
}

// NEW: Archive old games using Firebase Functions
async function archiveOldGames() {
  try {
    const storage = await createAnonymousUser();
    if (!storage) {
      throw new Error("Failed to authenticate user");
    }

    await signInAnonymously(auth);

    const archiveGames = httpsCallable(functions, 'archiveGamesToSheets');
    const result = await archiveGames({ 
      daysOld: 30,  // Archive games older than 30 days
      batchSize: 50 // Archive up to 50 games at once
    });
    
    console.log('Archive result:', result.data);
    return result.data;
  } catch (error) {
    console.error('Error archiving games:', error);
    throw error;
  }
}

function analyzeQuickStats(sessions) {
  if (sessions.length === 0) {
    return {
      recentScore: 0,
      bestScore: 0,
      totalGames: 0,
      avgScore: 0,
      slowestOperation: null,
      recommendation: 'Start playing to see your stats!'
    };
  }

  const recentScore = sessions[0].score;
  const bestScore = Math.max(...sessions.map(s => s.score));
  const totalGames = sessions.length;
  const avgScore = Math.round(sessions.reduce((sum, s) => sum + s.score, 0) / totalGames);

  let slowestOperation = null;
  if (sessions[0].problems.length > 0) {
    const operationLatencies = {};
    
    for (const problem of sessions[0].problems) {
      let operation = 'unknown';
      if (problem.question.includes('+')) operation = 'addition';
      else if (problem.question.includes('-')) operation = 'subtraction';
      else if (problem.question.includes('×') || problem.question.includes('*')) operation = 'multiplication';
      else if (problem.question.includes('÷') || problem.question.includes('/')) operation = 'division';
      
      if (!operationLatencies[operation]) {
        operationLatencies[operation] = [];
      }
      operationLatencies[operation].push(problem.latency);
    }
    
    let maxAvgLatency = 0;
    for (const [op, latencies] of Object.entries(operationLatencies)) {
      const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      if (avgLatency > maxAvgLatency) {
        maxAvgLatency = avgLatency;
        slowestOperation = op;
      }
    }
  }

  return {
    recentScore,
    bestScore,
    totalGames,
    avgScore,
    slowestOperation,
    recommendation: slowestOperation && slowestOperation !== 'unknown' 
      ? `Focus on ${slowestOperation} practice to improve your speed` 
      : 'Keep practicing to improve your mental math skills!'
  };
}

async function loadPopupData() {
  const loadingEl = document.getElementById('loading');
  const contentEl = document.getElementById('content');
  
  try {
    // Try to get stats from Firebase Functions (includes archived data)
    const stats = await getUserStatsFromFunctions();
    
    if (stats && stats.totalGames > 0) {
      document.getElementById('recent-score').textContent = stats.recentScore || 0;
      document.getElementById('session-count').textContent = stats.totalGames || 0;
      document.getElementById('best-score').textContent = stats.bestScore || 0;
      
      // Add average score display
      const avgScoreElement = document.getElementById('avg-score');
      if (avgScoreElement) {
        avgScoreElement.textContent = stats.avgScore || 0;
      }
      
      if (stats.slowestOperation && stats.slowestOperation !== 'unknown') {
        document.getElementById('recommendation-text').textContent = stats.recommendation;
        document.getElementById('recommendation').style.display = 'block';
      }

      // Show archive info if available
      if (stats.archivedGamesCount > 0) {
        const archiveInfo = document.getElementById('archive-info');
        if (archiveInfo) {
          archiveInfo.textContent = `(${stats.archivedGamesCount} archived)`;
          archiveInfo.style.display = 'inline';
        }
      }
    } else {
      document.getElementById('recent-score').textContent = 'No data';
      document.getElementById('session-count').textContent = '0';
      document.getElementById('best-score').textContent = '-';
    }
    
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
    
  } catch (error) {
    console.error('Error loading popup data:', error);
    loadingEl.textContent = 'Error loading data';
  }
}

function setupButtons() {
  document.getElementById('dashboard-btn').addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('dashboard/dashboard.html')
    });
  });
  
  document.getElementById('zetamac-btn').addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://arithmetic.zetamac.com'
    });
  });

  // NEW: Archive button
  const archiveBtn = document.getElementById('archive-btn');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', async () => {
      const originalText = archiveBtn.textContent;
      archiveBtn.textContent = 'Archiving...';
      archiveBtn.disabled = true;
      
      try {
        const result = await archiveOldGames();
        alert(`Successfully archived ${result.archivedCount} old game sessions!`);
        
        // Refresh the popup data to show updated counts
        await loadPopupData();
      } catch (error) {
        alert('Failed to archive games: ' + error.message);
      } finally {
        archiveBtn.textContent = originalText;
        archiveBtn.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadPopupData();
  setupButtons();
});
