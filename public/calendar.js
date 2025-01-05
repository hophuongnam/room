/* ------------------------------------------------------------------
   calendar.js
   - Initializes the FullCalendar instance (multiCalendar).
   - Persists the user-selected view (day/week/month) in localStorage.
   - Different behavior for resource vs. non-resource views:
     - Resource: selectMirror = true, can confirm info.resource
     - Non-resource: selectMirror = false + real-time highlight hack
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
    getFirstCheckedRoomColor,
    doesOverlap,
    openEventModal,
    openViewEventModal,
    updateEvent,
    deleteEvent
  } = window.calendarHelpers; 

  // Retrieve the last used view from localStorage, or default to 'timeGridWeek'
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

  // Create the FullCalendar instance
  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source',
    timeZone: 'local',
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '18:00:00',
    initialView: savedView,
    resourceOrder: 'orderIndex',
    firstDay: 1,

    headerToolbar: {
      left:   'prev,next today',
      center: 'title',
      right:  'resourceTimeGridDay,timeGridWeek,dayGridMonth'
    },

    editable: true,
    eventResizableFromStart: true,
    selectable: true,

    // "global" default if not overridden by a view:
    selectMirror: false,

    // You can override per-view using the 'views' config:
    views: {
      // For resource-based views, we want mirror
      resourceTimeGridDay: {
        selectMirror: true
      },
      resourceTimeGridWeek: {
        selectMirror: true
      },
      // For normal timeGrid / dayGrid, let it default to false
      timeGridWeek: {
        // selectMirror: false  // (already default)
      },
      dayGridMonth: {
        // ...
      }
    },

    resources(fetchInfo, successCallback, failureCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      const displayedResources = window.rooms
        .filter(r => selectedRoomIds.includes(r.id))
        .map(r => ({
          id: r.id,
          title: r.summary,
          orderIndex: r._sortOrder || 9999
        }));

      successCallback(displayedResources);
    },

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

    // Disallow selecting time in the past
    selectAllow(selectInfo) {
      return selectInfo.start >= new Date();
    },

    // Called when user drag-selects a time range
    select(info) {
      // If in resource view, we can confirm resource:
      if (info.resource) {
        console.log("User drag-selected on resource:", info.resource.id);
      }

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

    dateClick(info) {
      const start = info.date;
      const end   = new Date(start.getTime() + 30 * 60 * 1000);
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) {
        window.showToast('Notice', 'No room selected.');
        return;
      }
      if (start < new Date()) {
        window.showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: firstRoomId } };
      if (doesOverlap(dummyEvent, start, end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        return;
      }

      openEventModal({
        calendarId: firstRoomId,
        start,
        end
      });
    },

    eventClick(info) {
      // Resource ID for existing event => info.event.getResources() or ._def.resourceIds
      if (info.event._def && info.event._def.resourceIds) {
        console.log("Clicked event's resource IDs:", info.event._def.resourceIds);
      }

      const calendarId = info.event.extendedProps?.realCalendarId;
      if (!calendarId) return;
      openViewEventModal(info.event, calendarId);
    },

    eventDrop(info) {
      // If event was moved to another resource:
      if (info.newResource) {
        console.log("Event moved to new resource:", info.newResource.id);
      }

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

    // Save user-chosen view in localStorage
    viewDidMount(args) {
      localStorage.setItem('userSelectedView', args.view.type);
    }
  });

  // Finally, render the calendar
  window.multiCalendar.render();

  /* ------------------------------------------------------------------
     REAL-TIME HIGHLIGHT "HACK" FOR NON-RESOURCE VIEWS
     Only relevant if selectMirror: false
  ------------------------------------------------------------------ */
  // 1) Function to color all .fc-highlight elements
  function colorHighlightEls() {
    const color = getFirstCheckedRoomColor();
    const highlights = document.querySelectorAll('.fc-highlight');
    highlights.forEach(el => {
      el.style.backgroundColor = color;
      el.style.opacity = '0.3'; // tweak as needed
    });
  }

  // 2) Observe DOM changes in the FullCalendar container => color highlights
  const fcContainer = document.querySelector('.fc-view-harness');
  if (fcContainer) {
    const observer = new MutationObserver(() => {
      // whenever new highlight elements are inserted
      colorHighlightEls();
    });
    observer.observe(fcContainer, {
      childList: true,
      subtree: true
    });

    // Also color in response to mouse movements, so if FullCalendar re-renders
    // mid-drag, we keep recoloring in real-time
    fcContainer.addEventListener('mousemove', colorHighlightEls);
  }
}

/* Expose initCalendar to the global scope */
window.initCalendar = initCalendar;
