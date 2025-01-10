// freebusy.js

document.addEventListener('DOMContentLoaded', () => {
    let freeBusyCalendar = null;
  
    // Initialize the mini-calendar for free/busy
    function initFreeBusyCalendar() {
      const resourceCalendarEl = document.getElementById('resourceCalendar');
      if (!resourceCalendarEl) return;
  
      // Create a resource-based calendar to show each attendee in its own row
      freeBusyCalendar = new FullCalendar.Calendar(resourceCalendarEl, {
        schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source',
        timeZone: 'local',
        initialView: 'resourceTimeGridDay',
        height: 600,
        nowIndicator: true,
        slotMinTime: '06:00:00',
        slotMaxTime: '22:00:00',
        headerToolbar: {
          left: '',
          center: 'title',
          right: ''
        },
        // Do not allow editing or selecting in this mini view
        editable: false,
        selectable: false,
        resourceOrder: null,
        // We'll dynamically add resources & events
        resources: [],
        events: []
      });
  
      freeBusyCalendar.render();
      // Store globally so main.js can call populate
      window.freeBusyCalendar = freeBusyCalendar;
    }
  
    // POST /api/freebusy call is done in main.js (window.loadFreeBusyData).
    // We'll define that method here, but main.js calls it:
    // Global cache object
    if (!window.freeBusyCache) {
      window.freeBusyCache = {};
    }
    
    // TTL for freebusy cache entries (e.g., 5 minutes)
    const CACHE_TTL_MS = 5 * 60 * 1000;

    // Helper: compute busy blocks for the specified room from local memory
    function getLocalRoomBusy(roomId, startISO, endISO) {
      // If we don't have the events or room doesn't exist, return an empty array
      if (!window.allEventsMap || !window.allEventsMap[roomId]) return [];

      const events = window.allEventsMap[roomId];
      const startMs = new Date(startISO).getTime();
      const endMs   = new Date(endISO).getTime();

      const busySlots = [];
      // For each event, if it overlaps our range, push it as a busy block
      for (const ev of events) {
        if (!ev.start || !ev.end) continue;
        const evStart = new Date(ev.start).getTime();
        const evEnd   = new Date(ev.end).getTime();
        // if event overlaps [startMs, endMs], clamp it to that range
        if (evEnd > startMs && evStart < endMs) {
          const busyStart = new Date(Math.max(evStart, startMs)).toISOString();
          const busyEnd   = new Date(Math.min(evEnd, endMs)).toISOString();
          busySlots.push({ start: busyStart, end: busyEnd });
        }
      }
      return busySlots;
    }

    async function loadFreeBusyData(emails, startISO, endISO) {
      // Sort for stable cache key
      const sortedEmails = [...emails].sort();
      const cacheKey = JSON.stringify({ start: startISO, end: endISO, emails: sortedEmails });

      // If present in cache, check if it's still valid (TTL)
      if (window.freeBusyCache[cacheKey]) {
        const { timestamp, data } = window.freeBusyCache[cacheKey];
        const now = Date.now();
        if (now - timestamp < CACHE_TTL_MS) {
          // Cache entry is still fresh
          return data;
        } else {
          // Expired; remove entry
          delete window.freeBusyCache[cacheKey];
        }
      }

      // Separate out any known room IDs from user emails
      // (We'll handle the room locally)
      let roomId = null;
      let userEmails = [];
      for (const em of emails) {
        const maybeRoom = window.rooms?.find(r => r.id === em);
        if (maybeRoom) {
          roomId = maybeRoom.id;
        } else {
          userEmails.push(em);
        }
      }

      // If there's anything in userEmails, call /api/freebusy
      let serverBusy = {};
      if (userEmails.length > 0) {
        const res = await window.fetchJSON('/api/freebusy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: startISO,
            end: endISO,
            attendees: userEmails
          })
        });
        serverBusy = res.freebusy;  // { email => [ {start, end}, ... ] }
      }

      // If we have a local room ID, compute local busy for it
      if (roomId) {
        serverBusy[roomId] = getLocalRoomBusy(roomId, startISO, endISO);
      }

      // Cache and return
      window.freeBusyCache[cacheKey] = {
        timestamp: Date.now(),
        data: serverBusy
      };
      return serverBusy;
    }
  
    // Insert on window so main.js can invoke it
    window.loadFreeBusyData = loadFreeBusyData;
  
    // A helper to fill the resource-based calendar with busy blocks
    function populateFreeBusyCalendar(calendar, freebusyData) {
      if (!calendar) return;
  
      // 1) Clear out existing resources and events
      calendar.getResources().forEach(r => r.remove());
      calendar.getEvents().forEach(e => e.remove());
  
      // 2) Build resources from each email
      const resourceList = [];
      for (const email of Object.keys(freebusyData)) {
        // Check if the email matches a known room ID and use the room's summary if found
        let displayName = email;
        if (window.rooms && Array.isArray(window.rooms)) {
          const matchingRoom = window.rooms.find(r => r.id === email);
          if (matchingRoom) {
            displayName = matchingRoom.summary;
          }
        }
        resourceList.push({ id: email, title: displayName });
      }

      // Sort so the room's ID (if present) is first
      if (window.currentFreeBusyCalendarId) {
        resourceList.sort((a, b) => {
          if (a.id === window.currentFreeBusyCalendarId) return -1;
          if (b.id === window.currentFreeBusyCalendarId) return 1;
          return 0;
        });
      }

      // 3) Add resources to the calendar
      resourceList.forEach(r => {
        calendar.addResource(r);
      });
  
      // 4) For each resource, add "busy" intervals as background events
      for (const email of Object.keys(freebusyData)) {
        const busySlots = freebusyData[email];
        busySlots.forEach(slot => {
          calendar.addEvent({
            resourceId: email,
            start: slot.start,
            end: slot.end,
            display: 'background',
            backgroundColor: '#dc3545', // red
            // You can also do "classNames" or "groupId" if you want
          });
        });
      }
    }
  
    function renderTentativeRange(calendar, startISO, endISO) {
  // Remove old events from prior calls
  const oldEvents = calendar.getEvents().filter(e => e.groupId === 'tentativeRange');
  oldEvents.forEach(e => e.remove());

  // If no start/end or no resources, do nothing
  if (!startISO || !endISO) return;
  const resources = calendar.getResources();
  if (!resources || resources.length === 0) return;

  // For each resource, draw a special event with a colored border
  resources.forEach(r => {
    calendar.addEvent({
      id: 'tentativeRange-' + r.id,
      groupId: 'tentativeRange',
      resourceId: r.id,
      start: startISO,
      end: endISO,
      display: 'background',
      backgroundColor: 'rgba(13, 110, 253, 0.1)',  // light fill
      borderColor: '#0d6efd',                     // border color
      classNames: ['tentative-range']             // optional custom CSS
    });
  });
}

window.initFreeBusyCalendar       = initFreeBusyCalendar;
window.populateFreeBusyCalendar   = populateFreeBusyCalendar;
window.renderTentativeRange       = renderTentativeRange;
});
  