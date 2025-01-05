/* ------------------------------------------------------------------
   calendar.js
   - Only the FullCalendar initialization code
   - CRUD / Modal helpers are in calendar_helpers.js
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  // Destructure the helpers from the global object
  const {
    getFirstCheckedRoomId,
    doesOverlap,
    openEventModal,
    openViewEventModal,
    updateEvent,
    deleteEvent
  } = window.calendarHelpers; 

  // Retrieve last used view
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

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
      left: 'prev,next today',
      center: 'title',
      right: 'resourceTimeGridDay,timeGridWeek,dayGridMonth'
    },

    // Dragging/resizing
    editable: true,
    eventResizableFromStart: true,

    // For selecting new events
    selectable: true,
    selectMirror: true,

    // Dynamically load the checked rooms
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

    // Combine events from each checked room
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

    // Called for each event, including the mirror
    eventDidMount(info) {
      if (info.isMirror) {
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

    // No selection in the past
    selectAllow(selectInfo) {
      return selectInfo.start >= new Date();
    },

    // Selecting a time range => create event
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

      openEventModal({
        calendarId: firstRoomId,
        start: info.start,
        end: info.end
      });
    },

    // dateClick => quick 30-min event
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

      // Overlap check
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

    // Clicking an existing event => open read-only modal
    eventClick(info) {
      const event = info.event;
      const calendarId = event.extendedProps?.realCalendarId;
      if (!calendarId) return;
      openViewEventModal(event, calendarId);
    },

    // Drag an event => update
    eventDrop(info) {
      const event    = info.event;
      const newStart = event.start;
      const newEnd   = event.end || new Date(newStart.getTime() + 30*60*1000);

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
            end:   newEnd.toISOString(),
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

    // Resize an event => update
    eventResize(info) {
      const event    = info.event;
      const newStart = event.start;
      const newEnd   = event.end;
      if (!newEnd) {
        info.revert();
        return;
      }

      if (doesOverlap(event, newStart, newEnd)) {
        window.showToast('Error', 'Resized event overlaps. Reverting.');
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
            end:   newEnd.toISOString(),
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
    }
  });

  // Render the calendar
  window.multiCalendar.render();
}

// Optionally expose initCalendar globally:
window.initCalendar = initCalendar;
