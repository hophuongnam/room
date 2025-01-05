/* ------------------------------------------------------------------
   calendar.js
   - Initializes the FullCalendar instance (multiCalendar).
   - Persists the user-selected view (day/week/month) in localStorage.
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  // Destructure the helper methods from the global object (calendar_helpers.js)
  const {
    getFirstCheckedRoomId,
    doesOverlap,
    openEventModal,
    openViewEventModal,
    updateEvent,
    deleteEvent
  } = window.calendarHelpers; 

  // 1) Retrieve the last used view from localStorage, or default to 'timeGridWeek'
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

  // Create the FullCalendar instance
  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source',
    timeZone: 'local',
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '18:00:00',
    initialView: savedView,       // <-- Set the calendar's initial view
    resourceOrder: 'orderIndex',
    firstDay: 1,

    headerToolbar: {
      left:   'prev,next today',
      center: 'title',
      right:  'resourceTimeGridDay,timeGridWeek,dayGridMonth'
    },

    // Make events draggable & resizable
    editable: true,
    eventResizableFromStart: true,

    // Allow selecting a time range for new events
    selectable: true,
    selectMirror: true,

    // Provide resources (rooms) dynamically based on which checkboxes are checked
    resources(fetchInfo, successCallback, failureCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      // Return only the rooms that are currently selected
      const displayedResources = window.rooms
        .filter(r => selectedRoomIds.includes(r.id))
        .map(r => ({
          id: r.id,
          title: r.summary,
          orderIndex: r._sortOrder || 9999
        }));

      successCallback(displayedResources);
    },

    // Combine and return events from each checked room
    events(fetchInfo, successCallback, failureCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      const mergedEvents = [];
      for (const roomId of selectedRoomIds) {
        const roomEvents = window.allEventsMap[roomId] || [];
        roomEvents.forEach(ev => {
          mergedEvents.push({
            ...ev,
            resourceId: roomId,
            backgroundColor: window.roomColors[roomId] || '#333',
            textColor: '#fff',
            extendedProps: {
              ...(ev.extendedProps || {}),
              realCalendarId: roomId
            }
          });
        });
      }
      successCallback(mergedEvents);
    },

    // For the "mirror" event (the greyed-out event while selecting)
    eventDidMount(info) {
      if (info.isMirror) {
        // Attempt to color the mirror event consistently
        const resourceIds = info.event._def.resourceIds;
        if (resourceIds && resourceIds.length > 0) {
          const resourceId = resourceIds[0];
          if (window.roomColors && window.roomColors[resourceId]) {
            info.el.style.backgroundColor = window.roomColors[resourceId];
            info.el.style.color = '#fff';
          }
        }
      }
    },

    // Disallow selecting time in the past
    selectAllow(selectInfo) {
      return selectInfo.start >= new Date();
    },

    // Triggered when a user selects a time range
    select(info) {
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) {
        window.showToast('Notice', 'No room selected.');
        window.multiCalendar.unselect();
        return;
      }

      // Overlap check
      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: firstRoomId } };
      if (doesOverlap(dummyEvent, info.start, info.end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      // Open "create event" modal
      openEventModal({
        calendarId: firstRoomId,
        start: info.start,
        end: info.end
      });
    },

    // dateClick => create a quick 30-minute event if not overlapping
    dateClick(info) {
      const start = info.date;
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) {
        window.showToast('Notice', 'No room selected.');
        return;
      }
      // Prevent creating in the past
      if (start < new Date()) {
        window.showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      // Overlap check
      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: firstRoomId } };
      if (doesOverlap(dummyEvent, start, end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        return;
      }

      // Open "create event" modal
      openEventModal({
        calendarId: firstRoomId,
        start,
        end
      });
    },

    // Clicking an existing event => open read-only event modal
    eventClick(info) {
      const event = info.event;
      const calendarId = event.extendedProps?.realCalendarId;
      if (!calendarId) return;
      openViewEventModal(event, calendarId);
    },

    // Drag an event => update its start/end
    eventDrop(info) {
      const event = info.event;
      const newStart = event.start;
      const newEnd = event.end || new Date(newStart.getTime() + 30 * 60 * 1000);

      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'This move overlaps another event. Reverting.');
        info.revert();
        return;
      }

      const roomId = event.extendedProps?.realCalendarId;
      if (!roomId) {
        info.revert();
        return;
      }

      window.showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end: newEnd.toISOString(),
            participants: event.extendedProps.attendees || [],
            description: event.extendedProps.description || ""
          });
          window.showToast('Updated', 'Event was successfully moved.');
          await window.resyncSingleRoom(roomId);
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Failed to move event: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    // Resize an event => update its duration
    eventResize(info) {
      const event = info.event;
      const newStart = event.start;
      const newEnd = event.end;
      if (!newEnd) {
        info.revert();
        return;
      }

      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Resized event overlaps another. Reverting.');
        info.revert();
        return;
      }

      const roomId = event.extendedProps?.realCalendarId;
      if (!roomId) {
        info.revert();
        return;
      }

      window.showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end: newEnd.toISOString(),
            participants: event.extendedProps.attendees || [],
            description: event.extendedProps.description || ""
          });
          window.showToast('Updated', 'Event was resized successfully.');
          await window.resyncSingleRoom(roomId);
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Failed to resize event: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    // 2) Whenever the view changes, store the new view type in localStorage
    viewDidMount(args) {
      localStorage.setItem('userSelectedView', args.view.type);
    }
  });

  // Finally, render the calendar
  window.multiCalendar.render();
}

// Optionally expose initCalendar to the global scope
window.initCalendar = initCalendar;
