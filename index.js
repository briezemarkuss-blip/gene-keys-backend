const express = require('express');
const cors = require('cors');
const moment = require('moment-timezone');
const swisseph = require('swisseph');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Set swisseph ephemeris path if needed, but the package usually comes with default ephemeris files.
// swisseph.ephemeris_path = __dirname + '/ephe';

// Helper to get text snippet for a specific gate
function getGeneKeySnippet(gateNumber) {
  try {
    // In the deployed repo, KnowledgeBase is a sibling of index.js
    const kbPath = path.join(__dirname, 'KnowledgeBase', 'GeneKeys');
    const files = fs.readdirSync(kbPath);
    const regex = new RegExp(`^The ${gateNumber}(st|nd|rd|th) Gene Key`);
    const file = files.find(f => regex.test(f));
    
    if (file) {
      const content = fs.readFileSync(path.join(kbPath, file), 'utf-8');
      const lines = content.split('\n').map(l => l.trim());
      
      let proseLines = [];
      let foundProse = false;
      
      for (const line of lines) {
        // Skip empty lines
        if (line.length === 0) continue;
        
        // Skip markdown headers
        if (line.startsWith('#')) continue;
        
        // Skip lines that are entirely uppercase (headers) or start with specific metadata
        const isUppercaseHeader = line === line.toUpperCase() && /[A-Z]/.test(line);
        const isMetadata = /^(PROGRAMMING PARTNER|PHYSIOLOGY|CODON RING|AMINO ACID):/i.test(line) || /^\(\d+/.test(line);
        
        if (isUppercaseHeader || isMetadata) {
          // If we already started collecting prose, an uppercase header might mean the end of the first section,
          // but we want a good chunk. If we have enough text, we can stop.
          if (foundProse && proseLines.join(' ').length > 400) {
            break;
          }
          continue;
        }
        
        // If it's a normal prose line
        foundProse = true;
        proseLines.push(line);
      }
      
      return proseLines.join(' ');
    }
  } catch (err) {
    console.error("Error reading Gene Key file:", err);
    return `Error: ${err.message} at ${path.join(__dirname, 'KnowledgeBase', 'GeneKeys')}`;
  }
}

// HD Wheel starts at 41st Hexagram at 2°00'00" Aquarius (302 degrees)
const HD_WHEEL_START = 302.0;

// The sequence of the 64 Hexagrams around the wheel starting from 41
const HEXAGRAM_WHEEL = [
  41, 19, 13, 49, 30, 55, 37, 63, 22, 36, 25, 17, 21, 51, 42, 3, 
  27, 24, 2, 23, 8, 20, 16, 35, 45, 12, 15, 52, 39, 53, 62, 56, 
  31, 33, 7, 4, 29, 59, 40, 64, 47, 6, 46, 18, 48, 57, 32, 50, 
  28, 44, 1, 43, 14, 34, 9, 5, 26, 11, 10, 58, 38, 54, 61, 60
];

function calculateGateAndLine(longitude) {
  // Normalize longitude relative to HD Wheel Start
  let offset = longitude - HD_WHEEL_START;
  if (offset < 0) offset += 360.0;
  
  const arcPerHexagram = 360.0 / 64.0; // 5.625 degrees
  const arcPerLine = arcPerHexagram / 6.0; // 0.9375 degrees
  
  const hexIndex = Math.floor(offset / arcPerHexagram);
  const gate = HEXAGRAM_WHEEL[hexIndex];
  
  const remainder = offset - (hexIndex * arcPerHexagram);
  const line = Math.floor(remainder / arcPerLine) + 1; // 1-indexed (1 to 6)
  
  return { gate, line };
}

function getJulianDay(dateString, tzString) {
  const m = moment.tz(dateString, tzString); // "YYYY-MM-DD HH:mm"
  const year = m.year();
  const month = m.month() + 1;
  const day = m.date();
  const hour = m.hours() + m.minutes() / 60.0 + m.seconds() / 3600.0;
  
  // Calculate Julian Day (UT)
  return swisseph.swe_julday(year, month, day, hour, swisseph.SE_GREG_CAL);
}

function calculatePlanets(jd_ut) {
  const planets = [
    { name: 'Sun', id: swisseph.SE_SUN },
    { name: 'Earth', id: null }, // Earth is exactly opposite Sun
    { name: 'Moon', id: swisseph.SE_MOON },
    { name: 'NorthNode', id: swisseph.SE_TRUE_NODE },
    { name: 'SouthNode', id: null }, // Opposite North Node
    { name: 'Mercury', id: swisseph.SE_MERCURY },
    { name: 'Venus', id: swisseph.SE_VENUS },
    { name: 'Mars', id: swisseph.SE_MARS },
    { name: 'Jupiter', id: swisseph.SE_JUPITER },
    { name: 'Saturn', id: swisseph.SE_SATURN },
    { name: 'Uranus', id: swisseph.SE_URANUS },
    { name: 'Neptune', id: swisseph.SE_NEPTUNE },
    { name: 'Pluto', id: swisseph.SE_PLUTO },
  ];

  const results = {};
  
  for (const p of planets) {
    if (p.name === 'Earth') {
      let earthLong = results['Sun'].longitude + 180.0;
      if (earthLong >= 360.0) earthLong -= 360.0;
      results[p.name] = { longitude: earthLong, ...calculateGateAndLine(earthLong) };
    } else if (p.name === 'SouthNode') {
      let snLong = results['NorthNode'].longitude + 180.0;
      if (snLong >= 360.0) snLong -= 360.0;
      results[p.name] = { longitude: snLong, ...calculateGateAndLine(snLong) };
    } else {
      const flag = swisseph.SEFLG_SWIEPH | swisseph.SEFLG_SPEED;
      const res = swisseph.swe_calc_ut(jd_ut, p.id, flag);
      const longitude = res.longitude;
      results[p.name] = { longitude, ...calculateGateAndLine(longitude) };
    }
  }
  return results;
}

function findDesignJD(personalityJD, targetSunLong) {
  // We need to find the exact time when Sun was at targetSunLong (Personality Sun - 88 degrees)
  let target = targetSunLong - 88.0;
  if (target < 0) target += 360.0;
  
  // 1 degree is roughly 1 day. Let's make an initial guess 88 days prior.
  let guessJD = personalityJD - 88.0;
  
  // We will iterate until precision is < 0.0001 degrees
  for (let i = 0; i < 20; i++) {
    const res = swisseph.swe_calc_ut(guessJD, swisseph.SE_SUN, swisseph.SEFLG_SWIEPH | swisseph.SEFLG_SPEED);
    const guessSunLong = res.longitude;
    
    let diff = target - guessSunLong;
    // Handle wrap-around
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    
    if (Math.abs(diff) < 0.00001) {
      break;
    }
    
    // adjust guess by approx degrees to days
    // sun moves ~0.9856 degrees per day
    guessJD += diff / 0.9856;
  }
  
  return guessJD;
}

app.post('/calculate', (req, res) => {
  try {
    const { date, timezone } = req.body; // e.g. date: "1990-05-15 14:30", timezone: "Europe/London"
    
    const jd_personality = getJulianDay(date, timezone);
    const personalityPlanets = calculatePlanets(jd_personality);
    
    const jd_design = findDesignJD(jd_personality, personalityPlanets.Sun.longitude);
    const designPlanets = calculatePlanets(jd_design);
    
    const sunGate = personalityPlanets.Sun.gate;
    const readingSnippet = getGeneKeySnippet(sunGate);
    
    res.json({
      success: true,
      data: {
        personality: personalityPlanets,
        design: designPlanets,
        readingSnippet: readingSnippet
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Calculator backend running on port ${PORT}`);
});
