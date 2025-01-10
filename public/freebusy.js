/**
 * freebusy.js
 * This script provides the mini-calendar for free/busy queries,
 * as well as helper functions to load data, populate the calendar,
 * and render a tentative range for the user to adjust.
 */

// We wrap everything in an IIFE to avoid polluting the global scope
// except for the functions we explicitly attach to "window."
(function() {
  // We'll store a reference to the mini free/busy calendar here
  let freeBusyCalendar = null;

  // A global cache object to store free/busy responses briefly
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const freeBusyCache = {};

  /**
   * Initialize the mini-calendar for showing free/busy info.
   * This is called once when we switch to the "Find a time" tab.
   */
  function initFreeBusyCalendar() {
    const resourceCalendarEl = document.getElementById('resourceCalendar');
    if (!resourceCalendarEl) return;

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
      // We won't allow direct user editing in this mini free/busy calendar
      editable: true,            // We still set true so we can drag the "tentative range" if we like
      eventResizableFromStart: true,
      selectable: true,
      selectMirror: true,
      resources: [],
      events: []
    });

    freeBusyCalendar.render();
    // Attach the calendar to window so we can reference it outside
    window.freeBusyCalendar = freeBusyCalendar;
  }

  /**
   * Load free/busy data for the given attendees between start/end times.
   * We'll cache results for a few minutes to reduce calls.
   */
  async function loadFreeBusyData(emails, startISO, endISO) {
    // Sort emails for a stable cache key
    const sortedEmails = [...emails].sort();
    const cacheKey = JSON.stringify({ start: startISO, end: endISO, emails: sortedEmails });

    // Check cache
    const now = Date.now();
    const cachedEntry = freeBusyCache[cacheKey];
    if (cachedEntry && (now - cachedEntry.timestamp < CACHE_TTL_MS)) {
      return cachedEntry.data;
    }

    // Separate any recognized room ID from user emails
    let roomId = null;
    let userEmails = [];
    if (window.rooms && Array.isArray(window.rooms)) {
      for (const em of emails) {
        const maybeRoom = window.rooms.find(r => r.id === em);
        if (maybeRoom) {
          roomId = maybeRoom.id;
        } else {
          userEmails.push(em);
        }
      }
    } else {
      // If we don't have a global 'rooms' array, just treat them all as user emails
      userEmails = emails;
    }

    // If we have user emails, call /api/freebusy
    let serverBusy = {};
    if (userEmails.length > 0) {
      const body = {
        start: startISO,
        end: endISO,
        attendees: userEmails
      };
      const res = await window.fetchJSON('/api/freebusy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      serverBusy = res.freebusy; // { email => [ {start, end}, ... ] }
    }

    // Merge in local busy blocks for the roomId, if present
    if (roomId) {
      if (!serverBusy[roomId]) {
        serverBusy[roomId] = [];
      }
      const localRoomBusy = getLocalRoomBusy(roomId, startISO, endISO);
      serverBusy[roomId] = serverBusy[roomId].concat(localRoomBusy);
    }

    // Store in cache
    freeBusyCache[cacheKey] = {
      timestamp: now,
      data: serverBusy
    };

    return serverBusy;
  }

  /**
   * If we have the room events in local memory, we can mark them as busy.
   */
  function getLocalRoomBusy(roomId, startISO, endISO) {
    if (!window.allEventsMap || !window.allEventsMap[roomId]) {
      return [];
    }

    const events = window.allEventsMap[roomId];
    const startMs = new Date(startISO).getTime();
    const endMs   = new Date(endISO).getTime();
    const busySlots = [];

    for (const ev of events) {
      if (!ev.start || !ev.end) continue;
      const evStart = new Date(ev.start).getTime();
      const evEnd   = new Date(ev.end).getTime();
      // Check overlap
      if (evEnd > startMs && evStart < endMs) {
        const busyStart = new Date(Math.max(evStart, startMs)).toISOString();
        const busyEnd   = new Date(Math.min(evEnd, endMs)).toISOString();
        busySlots.push({ start: busyStart, end: busyEnd });
      }
    }
    return busySlots;
  }

  /**
   * Build the mini free/busy calendar's resources and events from the freebusy data.
   * Called by main.js after we fetch free/busy info.
   */
  function populateFreeBusyCalendar(calendar, freebusyData) {
    if (!calendar) return;

    // 1) Clear existing resources and events
    calendar.getResources().forEach(r => r.remove());
    calendar.getEvents().forEach(e => e.remove());

    // 2) Build resources from each email/room ID in freebusyData
    const resourceList = [];
    for (const email of Object.keys(freebusyData)) {
      let displayName = email;
      if (Array.isArray(window.rooms)) {
        const match = window.rooms.find(r => r.id === email);
        if (match) {
          displayName = match.summary;
        }
      }
      resourceList.push({ id: email, title: displayName });
    }

    // 3) Sort so the primary room is on top (if window.currentFreeBusyCalendarId is set)
    if (window.currentFreeBusyCalendarId) {
      resourceList.sort((a, b) => {
        if (a.id === window.currentFreeBusyCalendarId) return -1;
        if (b.id === window.currentFreeBusyCalendarId) return 1;
        return 0;
      });
    }

    // 4) Add resources to the mini-calendar
    resourceList.forEach(r => calendar.addResource(r));

    // 5) For each resource (email), add its busy intervals as background events
    for (const email of Object.keys(freebusyData)) {
      const busySlots = freebusyData[email];
      busySlots.forEach(slot => {
        calendar.addEvent({
          id: 'busy-' + email + '-' + slot.start,
          resourceId: email,
          start: slot.start,
          end: slot.end,
          display: 'background',
          backgroundColor: '#dc3545',
          overlap: true,
          editable: false
        });
      });
    }
  }

  /**
   * Render a "tentative range" on the mini-calendar so the user
   * can drag or resize the block to adjust the proposed time.
   */
  function renderTentativeRange(calendar, startISO, endISO) {
    if (!calendar) return;
    if (!startISO || !endISO) return;

    // Remove any existing tentative events
    const oldTents = calendar.getEvents().filter(e => e.groupId === 'tentativeRange');
    oldTents.forEach(e => e.remove());

    // Add a "tentative event" for each resource row
    const resources = calendar.getResources();
    resources.forEach(r => {
      calendar.addEvent({
        id: 'tentativeEvent-' + r.id,
        groupId: 'tentativeRange',
        resourceId: r.id,
        start: startISO,
        end: endISO,
        display: 'auto',
        backgroundColor: '#0d6efd',
        borderColor: '#0d6efd',
        textColor: '#fff',
        editable: true // allow user to drag/resize
      });
    });

    // If not already done, set up eventDrop and eventResize handlers for these tentative blocks
    if (!calendar.hasTentativeEventHandlers) {
      calendar.on('eventDrop', (info) => {
        if (info.event.groupId === 'tentativeRange') {
          syncTentativeTimes(info.event.start, info.event.end);
        }
      });
      calendar.on('eventResize', (info) => {
        if (info.event.groupId === 'tentativeRange') {
          syncTentativeTimes(info.event.start, info.event.end);
        }
      });
      calendar.hasTentativeEventHandlers = true;
    }
  }

  /**
   * Update the Start/End datetime-local fields in the main event form
   * based on the user's drag/resize in the mini free/busy calendar.
   */
  function syncTentativeTimes(newStart, newEnd) {
    const startField = document.getElementById('eventStart');
    const endField   = document.getElementById('eventEnd');
    if (!startField || !endField) return;

    function toLocalDateTimeInput(jsDate) {
      const year   = jsDate.getFullYear();
      const month  = String(jsDate.getMonth() + 1).padStart(2, '0');
      const day    = String(jsDate.getDate()).padStart(2, '0');
      const hour   = String(jsDate.getHours()).padStart(2, '0');
      const minute = String(jsDate.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hour}:${minute}`;
    }

    startField.value = toLocalDateTimeInput(newStart);
    endField.value   = toLocalDateTimeInput(newEnd);
  }

  // Finally, attach the functions to window so main.js can call them
  window.initFreeBusyCalendar = initFreeBusyCalendar;
  window.loadFreeBusyData = loadFreeBusyData;
  window.populateFreeBusyCalendar = populateFreeBusyCalendar;
  window.renderTentativeRange = renderTentativeRange;
})();