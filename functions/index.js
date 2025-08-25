const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// Initialize Google Sheets API
const serviceAccount = {
  type: "service_account",
  project_id: functions.config().google.project_id,
  private_key_id: functions.config().google.private_key_id,
  private_key: functions.config().google.private_key.replace(/\\n/g, '\n'),
  client_email: functions.config().google.client_email,
  client_id: functions.config().google.client_id,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: functions.config().google.client_x509_cert_url
};

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const MASTER_SPREADSHEET_ID = functions.config().sheets.master_sheet_id;

/**
 * Archive old game sessions to Google Sheets
 * Called from extension when user wants to archive data
 */
exports.archiveGamesToSheets = functions.https.onCall(async (data, context) => {
  try {
    // Verify user is authenticated
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated', 
        'User must be authenticated to archive games'
      );
    }

    const userId = context.auth.uid;
    const { daysOld = 30, batchSize = 100 } = data;
    
    console.log(`Starting archive for user: ${userId}, days old: ${daysOld}`);

    // Get old sessions from Firestore
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    const oldSessionsQuery = await db.collection('sessions')
      .where('userId', '==', userId)
      .where('timestamp', '<', cutoffDate)
      .limit(batchSize)
      .get();

    if (oldSessionsQuery.empty) {
      return {
        success: true,
        message: 'No old sessions found to archive',
        archivedCount: 0
      };
    }

    const sessionsToArchive = [];
    const sessionIds = [];
    
    // Process sessions for archival
    oldSessionsQuery.forEach(doc => {
      const data = doc.data();
      sessionIds.push(doc.id);
      
      // Calculate summary statistics
      const problems = data.problems || [];
      const avgLatency = problems.length > 0 
        ? problems.reduce((sum, p) => sum + (p.latency || 0), 0) / problems.length 
        : 0;
      
      const operationCounts = problems.reduce((counts, p) => {
        const op = getOperationType(p.question || '');
        counts[op] = (counts[op] || 0) + 1;
        return counts;
      }, {});

      sessionsToArchive.push([
        data.timestamp.toDate().toISOString(),
        userId,
        data.score || 0,
        problems.length,
        Math.round(avgLatency),
        operationCounts.addition || 0,
        operationCounts.subtraction || 0,
        operationCounts.multiplication || 0,
        operationCounts.division || 0,
        JSON.stringify(problems.slice(0, 5)) // Sample of first 5 problems for debugging
      ]);
    });

    // Append to Google Sheets
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      range: 'ArchivedGames!A:J',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        majorDimension: 'ROWS',
        values: sessionsToArchive
      }
    });

    // Delete archived sessions from Firestore
    const batch = db.batch();
    sessionIds.forEach(sessionId => {
      const sessionRef = db.collection('sessions').doc(sessionId);
      batch.delete(sessionRef);
    });
    
    await batch.commit();

    console.log(`Successfully archived ${sessionsToArchive.length} sessions for user: ${userId}`);

    return {
      success: true,
      message: `Successfully archived ${sessionsToArchive.length} old game sessions`,
      archivedCount: sessionsToArchive.length,
      oldestArchived: sessionsToArchive[0] ? sessionsToArchive[0][0] : null,
      newestArchived: sessionsToArchive[sessionsToArchive.length - 1] ? 
        sessionsToArchive[sessionsToArchive.length - 1][0] : null
    };

  } catch (error) {
    console.error('Archive function error:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to archive games: ' + error.message
    );
  }
});

/**
 * Get archived game data from Google Sheets for a user
 * Used by dashboard to show historical data
 */
exports.getArchivedGames = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'User must be authenticated to view archived games'
      );
    }

    const userId = context.auth.uid;
    const { limit = 100, startDate, endDate } = data;

    // Get data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      range: 'ArchivedGames!A:J'
    });

    if (!response.data.values) {
      return { games: [], totalCount: 0 };
    }

    const [headers, ...rows] = response.data.values;
    
    // Filter by user ID and date range
    let userGames = rows
      .filter(row => row[1] === userId) // userId is in column B (index 1)
      .map(row => ({
        timestamp: new Date(row[0]),
        userId: row[1],
        score: parseInt(row[2]) || 0,
        problemCount: parseInt(row[3]) || 0,
        avgLatency: parseInt(row[4]) || 0,
        additionCount: parseInt(row[5]) || 0,
        subtractionCount: parseInt(row[6]) || 0,
        multiplicationCount: parseInt(row[7]) || 0,
        divisionCount: parseInt(row[8]) || 0,
        sampleProblems: row[9] ? JSON.parse(row[9]) : []
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    // Apply date filters if provided
    if (startDate) {
      const start = new Date(startDate);
      userGames = userGames.filter(game => game.timestamp >= start);
    }
    
    if (endDate) {
      const end = new Date(endDate);
      userGames = userGames.filter(game => game.timestamp <= end);
    }

    // Apply limit
    const limitedGames = userGames.slice(0, limit);

    return {
      games: limitedGames,
      totalCount: userGames.length,
      hasMore: userGames.length > limit
    };

  } catch (error) {
    console.error('Get archived games error:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to retrieve archived games: ' + error.message
    );
  }
});

/**
 * Get user statistics combining Firebase + archived data
 */
exports.getUserStats = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'User must be authenticated to view stats'
      );
    }

    const userId = context.auth.uid;

    // Get recent games from Firestore
    const recentGamesQuery = await db.collection('sessions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    const recentGames = [];
    recentGamesQuery.forEach(doc => {
      const data = doc.data();
      recentGames.push({
        timestamp: data.timestamp.toDate(),
        score: data.score || 0,
        problems: data.problems || []
      });
    });

    // Get archived games summary
    const archivedResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      range: 'ArchivedGames!A:J'
    });

    let archivedGames = [];
    if (archivedResponse.data.values) {
      const [headers, ...rows] = archivedResponse.data.values;
      archivedGames = rows
        .filter(row => row[1] === userId)
        .map(row => ({
          timestamp: new Date(row[0]),
          score: parseInt(row[2]) || 0,
          problemCount: parseInt(row[3]) || 0,
          avgLatency: parseInt(row[4]) || 0
        }));
    }

    // Combine and calculate statistics
    const allGames = [...recentGames.map(g => ({ 
      timestamp: g.timestamp, 
      score: g.score,
      problems: g.problems 
    })), ...archivedGames.map(g => ({ 
      timestamp: g.timestamp, 
      score: g.score,
      problems: [] // Archived games don't have full problem data
    }))];

    const totalGames = allGames.length;
    const bestScore = totalGames > 0 ? Math.max(...allGames.map(g => g.score)) : 0;
    const recentScore = totalGames > 0 ? allGames[0].score : 0;
    const avgScore = totalGames > 0 
      ? Math.round(allGames.reduce((sum, g) => sum + g.score, 0) / totalGames) 
      : 0;

    // Recent games analysis (only from Firestore data with full problems)
    let slowestOperation = null;
    if (recentGames.length > 0) {
      const operationLatencies = {};
      
      recentGames.forEach(game => {
        (game.problems || []).forEach(problem => {
          const operation = getOperationType(problem.question || '');
          if (!operationLatencies[operation]) {
            operationLatencies[operation] = [];
          }
          operationLatencies[operation].push(problem.latency || 0);
        });
      });

      let maxAvgLatency = 0;
      Object.entries(operationLatencies).forEach(([op, latencies]) => {
        const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
        if (avgLatency > maxAvgLatency) {
          maxAvgLatency = avgLatency;
          slowestOperation = op;
        }
      });
    }

    return {
      totalGames,
      bestScore,
      recentScore,
      avgScore,
      slowestOperation,
      recentGamesCount: recentGames.length,
      archivedGamesCount: archivedGames.length,
      recommendation: slowestOperation && slowestOperation !== 'unknown' 
        ? `Focus on ${slowestOperation} practice to improve your speed`
        : 'Keep practicing to improve your mental math skills!'
    };

  } catch (error) {
    console.error('Get user stats error:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to get user statistics: ' + error.message
    );
  }
});

/**
 * Utility function to determine operation type from question text
 */
function getOperationType(questionText) {
  if (questionText.includes('+')) return 'addition';
  if (questionText.includes('-')) return 'subtraction';
  if (questionText.includes('×') || questionText.includes('*')) return 'multiplication';
  if (questionText.includes('÷') || questionText.includes('/')) return 'division';
  return 'unknown';
}
