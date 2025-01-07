// --calendar.js--
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
    updateEvent
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

    selectable: true,
    selectMirror: false,
    editable: true,
    eventResizableFromStart: true,

    views: {
      // If you want custom view settings, place them here
    },

    // Load resources from your rooms
    resources(fetchInfo, successCallback) {
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
    events(fetchInfo, successCallback) {
      const checkboxes = document.querySelectorAll('#roomsCheckboxBar input[type="checkbox"]');
      const selectedRoomIds = Array.from(checkboxes)
        .filter(ch => ch.checked)
        .map(ch => ch.value);

      const mergedEvents = [];
      for (const roomId of selectedRoomIds) {
        const roomEvents = window.allEventsMap[roomId] || [];
        roomEvents.forEach(ev => {
          const isLinked = ev.extendedProps?.is_linked === true;
          mergedEvents.push({
            ...ev,
            resourceId: roomId,
            backgroundColor: window.roomColors[roomId] || '#333',
            textColor: '#fff',
            extendedProps: {
              ...(ev.extendedProps || {}),
              realCalendarId: roomId
            },
            editable: !isLinked,
            startEditable: !isLinked,
            durationEditable: !isLinked
          });
        });
      }
      successCallback(mergedEvents);
    },

    // Prevent new event creation in the past
    selectAllow(selectInfo) {
      return selectInfo.start >= new Date();
    },

    // Called when user finishes drag-select to create a new event
    select(info) {
      let chosenRoomId;
      if (info.resource) {
        chosenRoomId = info.resource.id;
      } else {
        chosenRoomId = getFirstCheckedRoomId();
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

    // "Click to create" fallback
    dateClick(info) {
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

    // User dragged an existing event
    eventDrop(info) {
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end || new Date(newStart.getTime() + 30 * 60 * 1000);

      // If the user is dragging to a new resource (different room) => cross-room move
      const oldResource = info.oldResource;
      const newResource = info.newResource;

      // Linked events cannot be moved at all
      if (event.extendedProps?.is_linked) {
        window.showToast('Error', 'Cannot move a linked event. Edit the original event.');
        info.revert();
        return;
      }

      // If user is dragging across different rooms
      if (oldResource && newResource && oldResource.id !== newResource.id) {
        // => Move across rooms
        moveEventAcrossRooms(event, oldResource.id, newResource.id, newStart, newEnd, info);
        return;
      }

      // Otherwise => same-room move
      if (newStart < new Date()) {
        window.showToast('Error', 'Cannot move event to a past time.');
        info.revert();
        return;
      }
      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Overlap. Reverting.');
        info.revert();
        return;
      }

      // Same-room => normal update
      window.showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: event.extendedProps?.realCalendarId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end: newEnd.toISOString(),
            participants: event.extendedProps.attendees || [],
            description: event.extendedProps.description || ""
          });
          window.showToast('Updated', 'Event moved.');
          await window.resyncSingleRoom(event.extendedProps?.realCalendarId);
          window.multiCalendar.refetchEvents();
        } catch (err) {
          window.showError(`Failed: ${err.message}`);
          info.revert();
        } finally {
          window.hideSpinner();
        }
      }, 0);
    },

    // User resized an existing event
    eventResize(info) {
      const event = info.event;
      const newStart = event.start;
      const newEnd   = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }

      // Linked check
      if (event.extendedProps?.is_linked) {
        window.showToast('Error', 'Cannot resize a linked event. Edit the original event.');
        info.revert();
        return;
      }

      if (newStart < new Date()) {
        window.showToast('Error', 'Cannot resize event to start in the past.');
        info.revert();
        return;
      }

      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Overlap. Reverting.');
        info.revert();
        return;
      }

      window.showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: event.extendedProps?.realCalendarId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end: newEnd.toISOString(),
            participants: event.extendedProps.attendees || [],
            description: event.extendedProps.description || ""
          });
          window.showToast('Updated', 'Event resized.');
          await window.resyncSingleRoom(event.extendedProps?.realCalendarId);
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

  // "Real-time highlight hack"
  function colorHighlightEls() {
    const highlightEls = document.querySelectorAll('.fc-highlight');
    highlightEls.forEach(highlightEl => {
      const resourceCol = highlightEl.closest('[data-resource-id]');
      if (resourceCol) {
        const resourceId = resourceCol.getAttribute('data-resource-id');
        const color = window.roomColors[resourceId] || '#666';
        highlightEl.style.backgroundColor = color;
        highlightEl.style.opacity = '0.3';
      } else {
        const fallbackColor = getFirstCheckedRoomColor();
        highlightEl.style.backgroundColor = fallbackColor;
        highlightEl.style.opacity = '0.3';
      }
    });
  }

  const fcContainer = document.querySelector('.fc-view-harness');
  if (fcContainer) {
    const observer = new MutationObserver(() => {
      colorHighlightEls();
    });
    observer.observe(fcContainer, { childList: true, subtree: true });

    fcContainer.addEventListener('mousemove', colorHighlightEls);
  }

  // ----------------------------------------------------------------
  // NEW function to handle cross-room move via /api/move_event
  // ----------------------------------------------------------------
  async function moveEventAcrossRooms(event, oldRoomId, newRoomId, newStart, newEnd, info) {
    window.showSpinner();
    try {
      const title         = event.title;
      const startISO      = newStart.toISOString();
      const endISO        = newEnd.toISOString();
      const attendees     = event.extendedProps.attendees || [];
      const description   = event.extendedProps.description || "";

      // POST to /api/move_event
      const res = await window.fetchJSON('/api/move_event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldCalendarId: oldRoomId,
          newCalendarId: newRoomId,
          eventId:  event.id,
          title,
          start:   startISO,
          end:     endISO,
          attendees,
          description
        })
      });

      if (res.status === 'success') {
        // Refresh old & new calendars
        await window.resyncSingleRoom(oldRoomId);
        await window.resyncSingleRoom(newRoomId);
        window.multiCalendar.refetchEvents();
        window.showToast('Moved', 'Event successfully moved to the new room.');
      } else {
        throw new Error(res.error || 'Unknown error moving event');
      }
    } catch (err) {
      window.showError(`Move failed: ${err.message}`);
      info.revert();
    } finally {
      window.hideSpinner();
    }
  }
}

window.initCalendar = initCalendar;
