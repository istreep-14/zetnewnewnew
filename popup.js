console.log("Popup loaded");

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

function analyzeQuickStats(sessions) {
  if (sessions.length === 0) {
    return null;
  }

  const recentScore = sessions[0].score;
  const bestScore = Math.max(...sessions.map(s => s.score));
  const sessionCount = sessions.length;

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
    sessionCount,
    slowestOperation,
    recommendation: slowestOperation ? `Focus on ${slowestOperation} practice to improve your speed` : 'Keep practicing to improve your mental math skills!'
  };
}

async function loadPopupData() {
  const loadingEl = document.getElementById('loading');
  const contentEl = document.getElementById('content');
  
  try {
    await createAnonymousUser();
    
    const sessions = await getRecentSessions();
    const stats = analyzeQuickStats(sessions);
    
    if (stats) {
      document.getElementById('recent-score').textContent = stats.recentScore;
      document.getElementById('session-count').textContent = stats.sessionCount;
      document.getElementById('best-score').textContent = stats.bestScore;
      
      if (stats.slowestOperation && stats.slowestOperation !== 'unknown') {
        document.getElementById('recommendation-text').textContent = stats.recommendation;
        document.getElementById('recommendation').style.display = 'block';
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
}

document.addEventListener('DOMContentLoaded', () => {
  loadPopupData();
  setupButtons();
}); 