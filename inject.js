// problem tracking extension

let currentProblem = null;
let problemStartTime = null;
let gameData = [];
let userAnswer = "";
let gameActive = false;
let sessionSaved = false;
let lastScore = 0;
let lastScoreCheck = 0;
let initialGameDuration = null;
let maxTimerSeen = 0;

function isTokenExpired(tokenTimestamp) {
  // Firebase tokens expire after 1 hour (3600 seconds)
  const expirationTime = tokenTimestamp + (3600 * 1000); // Convert to milliseconds
  const bufferTime = 5 * 60 * 1000; // 5 minute buffer
  return Date.now() > (expirationTime - bufferTime);
}

async function ensureValidToken() {
  const storage = await chrome.storage.local.get(['authToken', 'userId', 'refreshToken', 'tokenTimestamp']);
  
  // If no token or expired, try to refresh
  if (!storage.authToken || (storage.tokenTimestamp && isTokenExpired(storage.tokenTimestamp))) {
    console.log('Token missing or expired, attempting refresh...');
    
    if (storage.refreshToken) {
      const refreshedAuth = await refreshAuthTokenWithRefreshToken(storage.refreshToken);
      if (refreshedAuth) {
        // Add timestamp to track when token was issued
        await chrome.storage.local.set({ ...refreshedAuth, tokenTimestamp: Date.now() });
        return refreshedAuth;
      }
    }
    
    // Fallback to creating new user
    const newAuth = await refreshAuthToken();
    if (newAuth) {
      await chrome.storage.local.set({ ...newAuth, tokenTimestamp: Date.now() });
      return newAuth;
    }
    
    return null;
  }
  
  return storage;
}

function getCurrentProblem() {
  const allElements = document.querySelectorAll('*');
  
  for (let element of allElements) {
    const text = element.textContent?.trim();
    if (!text) continue;
    
    const mathMatch = text.match(/(\d+\s*[+\-×÷*\/]\s*\d+)\s*=/);
    if (mathMatch) {
      const problem = mathMatch[1].replace(/\s+/g, ' ').trim();
      if (problem.length < 20 && element.offsetHeight > 0) {
        return problem;
      }
    }
  }
  
  return null;
}

function getScoreValue() {
  const allElements = document.querySelectorAll('*');
  let foundScore = 0;
  
  for (let element of allElements) {
    const text = element.textContent?.trim();
    if (text) {
      let scoreMatch = text.match(/Score:\s*(\d+)/);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1]);
        foundScore = Math.max(foundScore, score);
      }
    }
  }
  
  return foundScore;
}

function getGameScore() {
  const allElements = document.querySelectorAll('*');
  let foundScore = 0;
  
  for (let element of allElements) {
    const text = element.textContent?.trim();
    if (text) {
      // try multiple score patterns
      let scoreMatch = text.match(/Score:\s*(\d+)/);
      if (!scoreMatch) {
        scoreMatch = text.match(/Final score:\s*(\d+)/);
      }
      if (!scoreMatch) {
        scoreMatch = text.match(/Your final score:\s*(\d+)/);
      }
      
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1]);
        foundScore = Math.max(foundScore, score);
      }
    }
  }
  
  return foundScore;
}

function getTimeRemaining() {
  // try specific selectors for zetamac timer
  const selectors = [
    '#game .left',
    'span.left', 
    '#game span:first-child',
    'body > div:nth-child(2) > span:first-child'
  ];
  
  for (let selector of selectors) {
    const timerElement = document.querySelector(selector);
    if (timerElement) {
      const text = timerElement.textContent?.trim();
      console.log(`Timer element found with selector "${selector}", text: "${text}"`);
      
      if (text) {
        let timeMatch = text.match(/Seconds left:\s*(\d+)/i);
        if (timeMatch) {
          const seconds = parseInt(timeMatch[1]);
          console.log(`Timer detected: ${seconds} seconds remaining`);
          return seconds;
        }
      }
    }
  }
  
  // fallback search all elements for timer patterns
  const allElements = document.querySelectorAll('*');
  
  for (let element of allElements) {
    const text = element.textContent?.trim();
    if (text && text.length < 100) { // only check short text elements
      // try various timer patterns
      let timeMatch = text.match(/Seconds left:\s*(\d+)/i);
      if (!timeMatch) {
        timeMatch = text.match(/Time:\s*(\d+)/i);
      }
      if (!timeMatch) {
        timeMatch = text.match(/(\d+)\s*seconds/i);
      }
      if (!timeMatch) {
        timeMatch = text.match(/(\d{1,2}):(\d{2})/); // MM:SS format
      }
      
      if (timeMatch) {
        let seconds;
        if (timeMatch[2] !== undefined) {
          // mm:ss format
          seconds = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
        } else {
          seconds = parseInt(timeMatch[1]);
        }
        
        // only consider reasonable timer values
        if (seconds >= 0 && seconds <= 300) {
          console.log(`Timer detected via fallback: ${seconds} seconds remaining from element with text: "${text}"`);
          return seconds;
        } else {
          console.log(`Invalid timer value ${seconds} from text: "${text}"`);
        }
      }
    }
  }
  
  console.log("No timer found with any method");
  return null;
}

function detectGameDuration() {
  // use max timer value seen during game instead of current timer
  const timerValue = maxTimerSeen;
  
  if (timerValue === 0) {
    return null;
  }
  
  // based on max timer value seen during game
  if (timerValue > 90) {
    return 120;
  } else if (timerValue > 60) {
    return 90;
  } else if (timerValue > 30) {
    return 60;
  } else if (timerValue > 0) {
    return 30;
  }
  
  return null;
}

function checkGameEnd() {
  const timeRemaining = getTimeRemaining();
  
  // track max timer value seen
  if (timeRemaining !== null && timeRemaining > maxTimerSeen) {
    maxTimerSeen = timeRemaining;
    console.log(`Max timer updated: ${maxTimerSeen}s`);
  }
  
  // detect game duration if we haven't already and we're in an active game
  if (timeRemaining !== null && gameActive && initialGameDuration === null) {
    const detectedDuration = detectGameDuration();
    if (detectedDuration) {
      initialGameDuration = detectedDuration;
      console.log(`Game duration detected: ${initialGameDuration}s (max timer seen: ${maxTimerSeen}s, current: ${timeRemaining}s)`);
    }
  }
  
  if (timeRemaining !== null) {
    if (timeRemaining === 0 && gameActive && !sessionSaved) {
      console.log("Game ended - timer reached 0");
      sessionSaved = true;
      
      setTimeout(() => {
        const score = getGameScore();
        
        // log final problem if we were working on one
        if (currentProblem && problemStartTime) {
          const latency = Date.now() - problemStartTime;
          // use the most recent answer we captured
          const finalAnswer = answerForCurrentProblem || userAnswer || "unknown";
          console.log(`Final problem capture: problem="${currentProblem}", answerForCurrentProblem="${answerForCurrentProblem}", userAnswer="${userAnswer}", finalAnswer="${finalAnswer}"`);
          logProblemData(currentProblem, finalAnswer, latency);
        }
        
        // ensure count matches score
        const deficit = score - gameData.length;
        if (deficit > 0) {
          console.log(`Adding ${deficit} final placeholders to match score`);
          for (let i = 0; i < deficit; i++) {
            const placeholderProblem = {
              question: `final-missed-${gameData.length + 1}`,
              answer: "ultra-fast",
              latency: 0,
              operationType: "unknown"
            };
            gameData.push(placeholderProblem);
          }
        } else if (deficit < 0) {
          console.warn(`More problems tracked than score - removing ${Math.abs(deficit)} excess`);
          gameData = gameData.slice(0, score);
        }
        
        // show all problems captured
        console.log("Problems captured:", gameData.map((p, i) => `${i+1}: ${p.question} → ${p.answer}`));
        
        // validation
        if (gameData.length === score) {
          console.log(`Perfect match: Score ${score}, Problems tracked ${gameData.length}`);
        } else {
          console.warn(`Count mismatch: Score ${score}, Problems tracked ${gameData.length}`);
        }
        
        // only save sessions from 120-second games
        if (initialGameDuration === 120) {
          console.log(`Saving 120s game session with score: ${score}`);
          saveSessionToFirestore(score, gameData);
        } else {
          console.log(`Skipping session - not 120s game (was ${initialGameDuration}s)`);
        }
        
        gameActive = false;
        gameData = [];
        lastScore = 0;
        lastScoreCheck = 0;
        currentProblem = null;
        problemStartTime = null;
        answerForCurrentProblem = "";
        initialGameDuration = null;
        maxTimerSeen = 0;
      }, 1000);
    } else if (timeRemaining > 0 && sessionSaved) {
      // new game started
      console.log("New game detected - timer went from 0 to", timeRemaining);
      sessionSaved = false;
      gameActive = true;
      gameData = [];
      lastScoreCheck = 0;
      answerForCurrentProblem = "";
      maxTimerSeen = timeRemaining;
      initialGameDuration = null;
      console.log(`Starting new game (timer at ${timeRemaining}s)`);
    }
  }
}

function getOperationType(problemText) {
  if (problemText.includes('+')) return 'addition';
  if (problemText.includes('-')) return 'subtraction';
  if (problemText.includes('×') || problemText.includes('*')) return 'multiplication';
  if (problemText.includes('÷') || problemText.includes('/')) return 'division';
  return 'unknown';
}

function logProblemData(question, answer, latency) {
  const operationType = getOperationType(question);
  const problemData = { question, answer, latency, operationType };
  gameData.push(problemData);
  console.log(`Problem #${gameData.length}: ${question} → ${answer} (${latency}ms, ${operationType})`);
}

function getUserAnswer() {
  // try multiple selectors for input field
  let inputField = document.querySelector('input[type="text"]');
  if (!inputField) {
    inputField = document.querySelector('input[type="number"]');
  }
  if (!inputField) {
    inputField = document.querySelector('input');
  }
  if (!inputField) {
    inputField = document.querySelector('#answer');
  }
  
  // log all input fields if we can't find one
  if (!inputField) {
    const allInputs = document.querySelectorAll('input');
    console.log(`Found ${allInputs.length} input fields:`, Array.from(allInputs).map(inp => ({
      type: inp.type,
      id: inp.id,
      className: inp.className,
      value: inp.value
    })));
    return "";
  }
  
  return inputField ? inputField.value.trim() : "";
}

async function refreshAuthTokenWithRefreshToken(refreshToken) {
  try {
    console.log("Refreshing existing auth token...");
    const { getFirebaseApiKey } = await import('../config/firebase-config.js');
    const apiKey = await getFirebaseApiKey();
    
    if (!apiKey) {
      console.error("Firebase API key not available");
      return null;
    }
    
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    
    const data = await response.json();
    if (data.access_token) {
      const tokenData = {
        authToken: data.access_token,
        refreshToken: data.refresh_token,
        userId: data.user_id,
        tokenTimestamp: Date.now()
      };
      
      await chrome.storage.local.set(tokenData);
      console.log("Auth token refreshed for existing user:", data.user_id);
      return tokenData;
    } else {
      console.error("Token refresh failed:", data);
      return null;
    }
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

async function refreshAuthToken() {
  try {
    console.log("Creating new anonymous user...");
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
      const tokenData = {
        authToken: data.idToken,
        refreshToken: data.refreshToken,
        userId: data.localId,
        tokenTimestamp: Date.now()
      };
      
      await chrome.storage.local.set(tokenData);
      console.log("New anonymous user created:", data.localId);
      return tokenData;
    } else {
      console.error("Anonymous user creation failed:", data);
      return null;
    }
  } catch (error) {
    console.error("Anonymous user creation error:", error);
    return null;
  }
}

async function saveSessionToFirestore(score, problems) {
  try {
    // Ensure we have a valid token before making requests
    let storage = await ensureValidToken();
    
    if (!storage || !storage.authToken) {
      console.error("No valid auth token available - user not authenticated");
      return;
    }

    const sessionData = {
      fields: {
        score: { integerValue: score.toString() },
        timestamp: { timestampValue: new Date().toISOString() },
        userId: { stringValue: storage.userId },
        problems: {
          arrayValue: {
            values: problems.map(p => ({
              mapValue: {
                fields: {
                  question: { stringValue: p.question },
                  answer: { stringValue: p.answer || "" },
                  latency: { integerValue: p.latency.toString() }
                }
              }
            }))
          }
        }
      }
    };

    let response = await fetch('https://firestore.googleapis.com/v1/projects/smart-zetamac-coach/databases/(default)/documents/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${storage.authToken}`
      },
      body: JSON.stringify(sessionData)
    });
    
    // if 401, try to refresh token first, then create new user as fallback
    if (response.status === 401) {
      console.log("Token expired, attempting to refresh...");
      let newAuth = null;
      
      // try to refresh existing token if we have one
      if (storage.refreshToken) {
        newAuth = await refreshAuthTokenWithRefreshToken(storage.refreshToken);
      }
      
      // if refresh failed or no refresh token, create new anonymous user
      if (!newAuth) {
        console.log("Token refresh failed or unavailable, creating new anonymous user...");
        newAuth = await refreshAuthToken();
      }
      
      if (!newAuth) {
        console.error("Failed to refresh authentication, cannot save session");
        return;
      }
      
      // update sessiondata with userid (may be same if refreshed, new if created)
      sessionData.fields.userId.stringValue = newAuth.userId;
      
      // retry with new token
      response = await fetch('https://firestore.googleapis.com/v1/projects/smart-zetamac-coach/databases/(default)/documents/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${newAuth.authToken}`
        },
        body: JSON.stringify(sessionData)
      });
      
      console.log("Retry response status:", response.status);
    }
    
    if (response.ok) {
      console.log("Session saved successfully");
    } else {
      const errorText = await response.text();
      console.error("Firestore error:", response.status, errorText);
    }
  } catch (error) {
    console.error("Error saving session:", error);
  }
}

// answer tracking for current problem
let answerForCurrentProblem = "";

function startProblemObserver() {
  console.log("monitoring started");
  
  gameActive = true;
  lastScore = 0;
  lastScoreCheck = 0;
  gameData = [];
  
  // initialize max timer tracking and try to detect game duration
  const timeRemaining = getTimeRemaining();
  if (timeRemaining !== null) {
    maxTimerSeen = timeRemaining;
    const detectedDuration = detectGameDuration();
    if (detectedDuration) {
      initialGameDuration = detectedDuration;
      console.log(`Initial game duration detected: ${initialGameDuration}s (timer at ${timeRemaining}s)`);
    }
  }
  
  // try to detect the first problem
  let initialDetectionCount = 0;
  const detectInitialProblem = () => {
    const initialProblem = getCurrentProblem();
    initialDetectionCount++;
    console.log(`Attempt ${initialDetectionCount}: Looking for initial problem, found: "${initialProblem}", currentProblem: "${currentProblem}"`);
    
    if (initialProblem && !currentProblem) {
      currentProblem = initialProblem;
      problemStartTime = Date.now();
      console.log(`Initial problem detected on attempt ${initialDetectionCount}: ${initialProblem}`);
    } else if (initialDetectionCount < 10) {
      // keep trying for 1 second
      setTimeout(detectInitialProblem, 100);
    } else {
      console.log("Failed to detect initial problem after 10 attempts");
    }
  };
  
  detectInitialProblem();

  let lastAnswer = "";

  const observer = new MutationObserver((mutations) => {
    // check score to detect missed problems
    const currentScore = getScoreValue();
    if (currentScore > lastScoreCheck && gameActive) {
      const scoreIncrease = currentScore - lastScoreCheck;
      console.log(`Score increased from ${lastScoreCheck} to ${currentScore} (+${scoreIncrease})`);
      
      // only add placeholders for score increases we didn't track
      const missedProblems = scoreIncrease - 1; // -1 because we expect this mutation to also detect the problem change
      
      if (missedProblems > 0) {
        console.warn(`Score increased by ${scoreIncrease}, but expecting to track 1 problem. Missing ${missedProblems} ultra-fast problems.`);
        
        // add placeholder problems for ultra-fast answers we missed
        for (let i = 0; i < missedProblems; i++) {
          const placeholderProblem = {
            question: `missed-problem-${gameData.length + 1}`,
            answer: "ultra-fast",
            latency: 0,
            operationType: "unknown"
          };
          gameData.push(placeholderProblem);
          console.log(`Added placeholder problem #${gameData.length}: missed ultra-fast answer`);
        }
      }
      lastScoreCheck = currentScore;
    }
    
    // check if we need to log the current problem before it changes
    const newProblem = getCurrentProblem();
    
    if (newProblem && newProblem !== currentProblem && gameActive) {
      console.log(`Problem change: "${currentProblem}" → "${newProblem}"`);
      
      // log the previous problem if we had one
      if (currentProblem && problemStartTime) {
        const latency = Date.now() - problemStartTime;
        // use the answer we captured for this specific problem
        const finalAnswer = answerForCurrentProblem || lastAnswer || "unknown";
        logProblemData(currentProblem, finalAnswer, latency);
      }
      
      // set up for new problem
      currentProblem = newProblem;
      problemStartTime = Date.now();
      answerForCurrentProblem = "";
    } else if (!currentProblem && newProblem && gameActive) {
      // first problem detected during the game
      console.log(`First problem detected: ${newProblem}`);
      currentProblem = newProblem;
      problemStartTime = Date.now();
      answerForCurrentProblem = "";
    }
    
    // capture current answer after checking for problem changes
    const currentAnswer = getUserAnswer();
    if (currentAnswer && currentAnswer !== lastAnswer) {
      lastAnswer = currentAnswer;
      answerForCurrentProblem = currentAnswer;
      console.log(`Answer captured: ${currentAnswer} for problem: ${currentProblem}`);
    }
    
    // check for game end
    checkGameEnd();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    characterDataOldValue: true
  });
  
  // capture answers from all input events
  document.addEventListener('input', (event) => {
    console.log(`Input event: target=${event.target.tagName}, value="${event.target.value}"`);
    if (event.target.tagName === 'INPUT') {
      userAnswer = event.target.value;
      if (event.target.value !== lastAnswer && event.target.value.length > 0) {
        lastAnswer = event.target.value;
        answerForCurrentProblem = event.target.value;
        console.log(`Answer captured immediately: ${event.target.value} for problem: ${currentProblem}`);
      }
    }
  });
  
  // capture on keydown, keyup, change
  ['keydown', 'keyup', 'change', 'paste'].forEach(eventType => {
    document.addEventListener(eventType, (event) => {
      if (event.target.tagName === 'INPUT') {
        // small delay to let the value update
        setTimeout(() => {
          const value = event.target.value;
          if (value && value !== lastAnswer) {
            lastAnswer = value;
            answerForCurrentProblem = value;
            console.log(`Answer from ${eventType}: ${value} for problem: ${currentProblem}`);
          }
        }, 1);
      }
    });
  });
  
  // polling to catch missed answers
  setInterval(() => {
    if (gameActive) {
      const currentAnswer = getUserAnswer();
      if (currentAnswer && currentAnswer !== lastAnswer) {
        lastAnswer = currentAnswer;
        answerForCurrentProblem = currentAnswer;
        console.log(`Answer from polling: ${currentAnswer} for problem: ${currentProblem}`);
      }
    }
  }, 10);
  
  // periodic check of input field status
  setInterval(() => {
    if (gameActive) {
      const inputField = document.querySelector('input');
      if (inputField) {
        console.log(`input field found: value="${inputField.value}", type="${inputField.type}", focused=${document.activeElement === inputField}`);
      } else {
        console.log('no input field found');
      }
    }
  }, 2000);
}

setTimeout(() => {
  console.log("starting monitoring...");
  startProblemObserver();
}, 1000); 