/* ------------------------------------------------------------------
   calendar.js
   - Sets up FullCalendar and handles event CRUD logic
   - Relies on globals from main.js:
       showToast, showError, showSpinner, hideSpinner, fetchJSON, etc.
       currentUserEmail, prefetchedUsers, rooms, allEventsMap, roomColors...
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');

  const { 
    rooms, 
    allEventsMap, 
    currentUserEmail,
    fetchJSON,
    showToast,
    showError,
    showSpinner,
    hideSpinner,
    roomColors
  } = window;

  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    timeZone: 'local',
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '18:00:00',
    initialView: 'timeGridWeek',
    firstDay: 1,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    selectable: true,
    selectMirror: true,
    unselectAuto: false, // keep highlight until we manually unselect
    editable: true,
    eventResizableFromStart: true,

    selectAllow: (selectInfo) => {
      // Prevent creating events in the past
      if (selectInfo.start < new Date()) {
        return false;
      }
      return true;
    },

    select: (info) => {
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) return;

      // Color highlight for selection
      const color = roomColors[firstRoomId] || '#0d6efd';
      setTimeout(() => {
        const highlights = document.querySelectorAll('.fc-highlight');
        highlights.forEach((el) => {
          el.style.backgroundColor = color;
        });
      }, 0);

      // Overlap check
      const dummyEvent = { 
        id: 'dummy', 
        source: { id: firstRoomId }
      };
      if (doesOverlap(dummyEvent, info.start, info.end, window.multiCalendar)) {
        showToast('Error', 'Time slot overlaps another event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      // Open create event modal
      openEventModal({
        calendarId: firstRoomId,
        start: info.start,
        end: info.end
      });
    },

    dateClick: (info) => {
      const start = info.date;
      const end   = new Date(start.getTime() + 30 * 60 * 1000);

      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) return;

      // Block clicks in the past
      if (start < new Date()) {
        showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      // Overlap check
      const dummyEvent = { 
        id: 'dummy', 
        source: { id: firstRoomId }
      };
      if (doesOverlap(dummyEvent, start, end, window.multiCalendar)) {
        showToast('Error', 'Time slot overlaps another event in that room.');
        return;
      }

      // Open create event modal
      openEventModal({
        calendarId: firstRoomId,
        start,
        end
      });
    },

    eventClick: (clickInfo) => {
      const calendarId = clickInfo.event.source?.id || null;
      if (calendarId) {
        openViewEventModal(clickInfo.event, calendarId);
      }
    },

    eventDrop: (info) => {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end || new Date(newStart.getTime() + 30*60*1000);

      // Overlap check
      if (doesOverlap(event, newStart, newEnd, window.multiCalendar)) {
        showToast('Error', "This move overlaps another event in the same room. Reverting.");
        info.revert();
        return;
      }

      const roomId = event.source?.id;
      if (!roomId) {
        info.revert();
        return;
      }

      showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end:   newEnd.toISOString(),
            participants: event.extendedProps.attendees || []
          });
          showToast("Updated", "Event was successfully moved.");
          await resyncSingleRoom(roomId);
          window.multiCalendar.getEventSourceById(roomId)?.refetch();
        } catch (err) {
          console.error("Failed to move event:", err);
          showError(`Failed to move event: ${err.message}`);
          info.revert();
        } finally {
          hideSpinner();
        }
      }, 0);
    },

    eventResize: (info) => {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }

      // Overlap check
      if (doesOverlap(event, newStart, newEnd, window.multiCalendar)) {
        showToast('Error', "Resized event overlaps another event in the same room. Reverting.");
        info.revert();
        return;
      }

      const roomId = event.source?.id;
      if (!roomId) {
        info.revert();
        return;
      }

      showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end:   newEnd.toISOString(),
            participants: event.extendedProps.attendees || []
          });
          showToast("Updated", "Event was resized successfully.");
          await resyncSingleRoom(roomId);
          window.multiCalendar.getEventSourceById(roomId)?.refetch();
        } catch (err) {
          console.error("Failed to resize event:", err);
          showError(`Failed to resize event: ${err.message}`);
          info.revert();
        } finally {
          hideSpinner();
        }
      }, 0);
    },

    eventSources: []
  });

  window.multiCalendar.render();

  // If user closes the Create/Edit modal, unselect highlight
  const eventModalEl = document.getElementById('eventModal');
  if (eventModalEl) {
    eventModalEl.addEventListener('hide.bs.modal', () => {
      window.multiCalendar.unselect();
    });
  }

  // Overlap check helper
  function doesOverlap(movingEvent, newStart, newEnd, calendar) {
    const allEvents = calendar.getEvents();
    const newStartMs = newStart.getTime();
    const newEndMs   = newEnd.getTime();

    for (const ev of allEvents) {
      if (ev.id === movingEvent.id) continue;
      const evStart = ev.start?.getTime();
      const evEnd   = (ev.end || ev.start)?.getTime();
      if (evStart < newEndMs && evEnd > newStartMs) {
        if (sameRoomSource(movingEvent, ev)) {
          return true;
        }
      }
    }
    return false;
  }

  function sameRoomSource(evA, evB) {
    const srcIdA = evA.source?.id || '';
    const srcIdB = evB.source?.id || '';
    return (srcIdA === srcIdB);
  }

  function getFirstCheckedRoomId() {
    const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
    if (!roomsCheckboxBar) return null;
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    const checked = Array.from(checkboxes).filter(ch => ch.checked);
    return checked.length > 0 ? checked[0].value : null;
  }

  // Return all checked room IDs
  function getCheckedRoomIds() {
    const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
    if (!roomsCheckboxBar) return [];
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    return Array.from(checkboxes)
      .filter(ch => ch.checked)
      .map(ch => ch.value);
  }

  /* ------------------------------------------------------------------
     View Event Modal
  ------------------------------------------------------------------ */
  window.openViewEventModal = function(event, calendarId) {
    // ... (unchanged code from your original)
    // ...
    const bsModal = new bootstrap.Modal(document.getElementById('viewEventModal'));
    bsModal.show();
  };

  /* ------------------------------------------------------------------
     Create/Edit Modal
  ------------------------------------------------------------------ */
  function openEventModal({ calendarId, eventId, title, start, end, attendees }) {
    const {
      eventModal,
      calendarIdField,
      eventIdField,
      eventTitleField,
      eventStartField,
      eventEndField
    } = window;

    // Grab references
    const eventRoomSelect  = document.getElementById('eventRoomSelect');
    const roomColorSquare  = document.getElementById('roomColorSquare');

    // Clear any old <option>
    eventRoomSelect.innerHTML = '';

    // Decide which room is selected
    const checkedRoomIds = getCheckedRoomIds();
    let defaultCalId = calendarId;
    if (!defaultCalId) {
      defaultCalId = (checkedRoomIds.length > 0)
        ? checkedRoomIds[0]
        : (rooms.length > 0 ? rooms[0].id : null);
    }

    // Populate <select> with each room
    rooms.forEach((room) => {
      const option = document.createElement('option');
      option.value = room.id;
      option.textContent = room.summary;
      if (room.id === defaultCalId) {
        option.selected = true;
      }
      eventRoomSelect.appendChild(option);
    });

    // Function to update the color square
    function setSquareColor(calId) {
      const c = roomColors[calId] || '#666';
      roomColorSquare.style.backgroundColor = c;
    }

    // Initially set the square color
    setSquareColor(defaultCalId);

    // If user changes selection, update color
    eventRoomSelect.addEventListener('change', () => {
      setSquareColor(eventRoomSelect.value);
    });

    // Fill hidden fields
    calendarIdField.value = defaultCalId || '';
    eventIdField.value    = eventId      || '';
    eventTitleField.value = title        || '';

    // Start/end
    if (start) {
      eventStartField.value = window.toLocalDateTimeInput(new Date(start));
    } else {
      eventStartField.value = '';
    }
    if (end) {
      eventEndField.value = window.toLocalDateTimeInput(new Date(end));
    } else {
      eventEndField.value = '';
    }

    // Reset chips
    window.inviteChips = [];
    window.clearChipsUI();

    // Pre-populate attendees
    if (attendees && attendees.length > 0) {
      attendees.forEach((email) => {
        const userObj = window.prefetchedUsers.find(u => u.email === email);
        if (userObj) {
          window.addChip({
            label: userObj.name ? `${userObj.name} <${userObj.email}>` : userObj.email,
            email: userObj.email
          });
        } else {
          window.addChip({ label: email, email });
        }
      });
      window.renderChipsUI();
    }

    // Show the modal
    eventModal.show();
  }

  window.openEventModal = openEventModal;

  // Save: create or update event
  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const {
      calendarIdField,
      eventIdField,
      eventTitleField,
      eventStartField,
      eventEndField,
      inviteChips
    } = window;

    // whichever room is selected
    const eventRoomSelect = document.getElementById('eventRoomSelect');
    const chosenCalendarId = eventRoomSelect.value;

    const eventId    = eventIdField.value;
    const title      = eventTitleField.value.trim();
    const localStart = new Date(eventStartField.value);
    const localEnd   = new Date(eventEndField.value);
    const startUTC   = localStart.toISOString();
    const endUTC     = localEnd.toISOString();
    const participants = inviteChips.map(ch => ch.email);

    if (!chosenCalendarId || !title) {
      showError('Missing required fields.');
      return;
    }
    if (!startUTC || !endUTC) {
      showError('Missing start or end time.');
      return;
    }
    if (localStart < new Date()) {
      showError('Cannot create or update an event in the past.');
      return;
    }
    if (localEnd <= localStart) {
      showError('End time must be after start time.');
      return;
    }

    showSpinner();
    try {
      if (eventId) {
        // Updating existing
        await updateEvent({
          calendarId: chosenCalendarId,
          eventId,
          title,
          start: startUTC,
          end: endUTC,
          participants
        });
        showToast("Updated", "Event was successfully updated.");
      } else {
        // Creating new
        await createEvent({
          calendarId: chosenCalendarId,
          title,
          start: startUTC,
          end: endUTC,
          participants
        });
        showToast("Created", "Event was successfully created.");
      }
      await resyncSingleRoom(chosenCalendarId);
      window.multiCalendar.getEventSourceById(chosenCalendarId)?.refetch();

      window.eventModal.hide();
      window.multiCalendar.unselect();
    } catch (err) {
      showError(`Failed to save event: ${err.message}`);
    } finally {
      hideSpinner();
    }
  });

  /* Event CRUD helpers */
  async function createEvent({ calendarId, title, start, end, participants }) {
    return fetchJSON('/api/create_event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, title, start, end, participants }),
    });
  }
  async function updateEvent({ calendarId, eventId, title, start, end, participants }) {
    return fetchJSON('/api/update_event', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, eventId, title, start, end, participants }),
    });
  }
  async function deleteEvent({ calendarId, id }) {
    return fetchJSON('/api/delete_event', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, id }),
    });
  }

  /* Re-sync single room (used by polling in main.js) */
  window.resyncSingleRoom = async function(roomId) {
    try {
      const resp = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(roomId)}`);
      window.allEventsMap[roomId] = resp.events || [];
    } catch (err) {
      showError(`Failed to re-sync room: ${roomId}. ${err.message}`);
    }
  };
}
