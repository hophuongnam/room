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
        resourceOrder: 'title',
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
    async function loadFreeBusyData(emails, startISO, endISO) {
      const res = await window.fetchJSON('/api/freebusy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: startISO,
          end: endISO,
          attendees: emails
        })
      });
      return res.freebusy;  // { email => [ {start, end}, ... ] }
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
        resourceList.push({ id: email, title: email });
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
  
    window.initFreeBusyCalendar       = initFreeBusyCalendar;
    window.populateFreeBusyCalendar   = populateFreeBusyCalendar;
  });
  