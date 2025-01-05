function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  const {
    getFirstCheckedRoomId,
    getFirstCheckedRoomColor,
    doesOverlap,
    openEventModal,
    openViewEventModal,
    updateEvent,
    deleteEvent
  } = window.calendarHelpers;

  // Use localStorage or default
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

  // Create FullCalendar
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

    // We turn OFF mirror in all views => highlight rectangles
    selectable: true,
    selectMirror: false,
    editable: true,
    eventResizableFromStart: true,

    views: {
      // If you want to keep them all highlight-based, no overrides needed
      // resourceTimeGridDay: { selectMirror: false },  // default is already false globally
      // resourceTimeGridWeek: { selectMirror: false }
    },

    // Load resources from your rooms
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

    // Merge events from the checked rooms
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

    selectAllow(selectInfo) {
      // disallow past
      return selectInfo.start >= new Date();
    },

    // Called when user finishes drag-select
    select(info) {
      // If resource-based => we have info.resource.id
      let chosenRoomId;
      if (info.resource) {
        chosenRoomId = info.resource.id;
        console.log("User drag-selected resource:", chosenRoomId);
      } else {
        // Non-resource => fallback
        chosenRoomId = getFirstCheckedRoomId();
        console.log("Non-resource => first checked room:", chosenRoomId);
      }

      if (!chosenRoomId) {
        window.showToast('Notice', 'No room selected.');
        window.multiCalendar.unselect();
        return;
      }

      // Overlap check
      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: chosenRoomId } };
      if (doesOverlap(dummyEvent, info.start, info.end)) {
        window.showToast('Error', 'Overlaps an existing event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      // Create
      openEventModal({
        calendarId: chosenRoomId,
        start: info.start,
        end: info.end
      });
    },

    dateClick(info) {
      // simpler "click to create"
      const start = info.date;
      const end   = new Date(start.getTime() + 30 * 60 * 1000);
      let chosenRoomId = getFirstCheckedRoomId();
      if (!chosenRoomId) {
        window.showToast('Notice', 'No room selected.');
        return;
      }

      if (start < new Date()) {
        window.showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: chosenRoomId } };
      if (doesOverlap(dummyEvent, start, end)) {
        window.showToast('Error', 'Overlap detected. Reverting.');
        return;
      }

      openEventModal({
        calendarId: chosenRoomId,
        start,
        end
      });
    },

    eventClick(info) {
      const calId = info.event.extendedProps?.realCalendarId;
      if (!calId) return;
      openViewEventModal(info.event, calId);
    },

    eventDrop(info) {
      // user dragged an existing event
      const event = info.event;
      if (info.newResource) {
        console.log("Moved to resource:", info.newResource.id);
      }
      const newStart = event.start;
      const newEnd   = event.end || new Date(newStart.getTime() + 30 * 60 * 1000);
      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Overlap. Reverting.');
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
          window.showToast('Updated', 'Event moved.');
          await window.resyncSingleRoom(roomId);
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Failed: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    eventResize(info) {
      // resizing
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end;
      if (!newEnd) {
        info.revert();
        return;
      }
      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Overlap. Reverting.');
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
          window.showToast('Updated', 'Event resized.');
          await window.resyncSingleRoom(roomId);
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Resize failed: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    viewDidMount(args) {
      localStorage.setItem('userSelectedView', args.view.type);
    }
  });

  // Render the calendar
  window.multiCalendar.render();

  /* ------------------------------------------------------------------
     REAL-TIME HIGHLIGHT HACK
     For resource view, each column has data-resource-id => we can color
     the highlight to match that resource column's color.
  ------------------------------------------------------------------ */
  function colorHighlightEls() {
    const highlightEls = document.querySelectorAll('.fc-highlight');
    highlightEls.forEach(highlightEl => {
      // Resource columns typically have .fc-timegrid-col[data-resource-id="X"]
      // The highlight is nested inside that col. We find it:
      const resourceCol = highlightEl.closest('[data-resource-id]');

      if (resourceCol) {
        // If found => color by resource ID
        const resourceId = resourceCol.getAttribute('data-resource-id');
        const color = window.roomColors[resourceId] || '#666';
        highlightEl.style.backgroundColor = color;
        highlightEl.style.opacity = '0.3';
      } else {
        // If not found => fallback to the "first checked room" color (non-resource)
        const fallbackColor = getFirstCheckedRoomColor();
        highlightEl.style.backgroundColor = fallbackColor;
        highlightEl.style.opacity = '0.3';
      }
    });
  }

  const fcContainer = document.querySelector('.fc-view-harness');
  if (fcContainer) {
    // watch for new highlight elements
    const observer = new MutationObserver(() => {
      colorHighlightEls();
    });
    observer.observe(fcContainer, { childList: true, subtree: true });

    // also re-color on mousemove
    fcContainer.addEventListener('mousemove', colorHighlightEls);
  }
}

/* Expose it if needed */
window.initCalendar = initCalendar;
