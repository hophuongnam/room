/* ------------------------------------------------------------------
   calendar.js
   - Sets up FullCalendar and handles event CRUD logic
   - Relies on globals from main.js:
       showToast, showError, showSpinner, hideSpinner, fetchJSON, etc.
       currentUserEmail, prefetchedUsers, rooms, allEventsMap, ...
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

      openEventModal({
        calendarId: firstRoomId,
        start,
        end
      });
    },

    eventClick: (clickInfo) => {
      const calendarId = clickInfo.event.source?.id || null;
      openViewEventModal(clickInfo.event, calendarId);
    },

    eventDrop: (info) => {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end || new Date(newStart.getTime() + 30*60*1000);

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

  // If user closes the modal, unselect highlight
  const eventModalEl = document.getElementById('eventModal');
  if (eventModalEl) {
    eventModalEl.addEventListener('hide.bs.modal', () => {
      window.multiCalendar.unselect();
    });
  }

  /* ------------------------------------------------------------------
     Overlap Checking
  ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------
     View Event Modal
  ------------------------------------------------------------------ */
  function openViewEventModal(event, calendarId) {
    if (!calendarId) return;

    const {
      viewEventModal,
      viewEventTitle,
      viewEventStart,
      viewEventEnd,
      viewEventEditBtn,
      viewEventDeleteBtn,
      viewEventOrganizerChips,
      viewEventAttendeesChips
    } = window;

    // NEW: Find the room name
    const foundRoom = rooms.find(r => r.id === calendarId);
    const roomName  = foundRoom ? foundRoom.summary : "Unknown Room";

    const roomColor = roomColors[calendarId] || '#0d6efd';
    const modalHeader = document.querySelector('#viewEventModal .modal-header');
    modalHeader.classList.add('text-white');
    modalHeader.style.backgroundColor = roomColor;

    // Assign the event title
    viewEventTitle.textContent = event.title || 'Untitled';

    // Fill the new "Room" field
    const viewEventRoomEl = document.getElementById('viewEventRoom');
    if (viewEventRoomEl) {
      viewEventRoomEl.textContent = roomName;
    }

    const startTime = event.start ? new Date(event.start) : null;
    const endTime   = event.end   ? new Date(event.end)   : null;
    const formatOptions = {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    };
    viewEventStart.textContent = startTime
      ? startTime.toLocaleString(undefined, formatOptions)
      : 'N/A';
    viewEventEnd.textContent   = endTime
      ? endTime.toLocaleString(undefined, formatOptions)
      : 'N/A';

    const rawOrganizer = event.extendedProps?.organizer || event.extendedProps?.creator_email || '';
    const rawAttendees = event.extendedProps?.attendees || event.attendees?.map(a => a.email) || [];

    const orgObj = window.prefetchedUsers.find(u => 
      u.email?.toLowerCase() === rawOrganizer.toLowerCase()
    );
    const organizerLabel = orgObj
      ? `${orgObj.name} <${orgObj.email}>`
      : rawOrganizer;

    const attendeeLabels = rawAttendees.map(addr => {
      const found = window.prefetchedUsers.find(u => 
        u.email?.toLowerCase() === addr.toLowerCase()
      );
      return found
        ? `${found.name} <${found.email}>`
        : addr;
    });

    renderReadOnlyChips(viewEventOrganizerChips, [organizerLabel]);
    renderReadOnlyChips(viewEventAttendeesChips, attendeeLabels);

    const isLinked = (event.extendedProps?.is_linked === 'true');
    let canEditOrDelete = true;
    if (isLinked) {
      canEditOrDelete = false;
    } else {
      // If user is neither organizer nor attendee, disallow
      if (!rawAttendees.includes(currentUserEmail) && rawOrganizer !== currentUserEmail) {
        canEditOrDelete = false;
      }
    }
    viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
    viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

    viewEventEditBtn.onclick = () => {
      if (canEditOrDelete) {
        openEventModal({
          calendarId,
          eventId: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          attendees: rawAttendees
        });
      }
      viewEventModal.hide();
    };

    viewEventDeleteBtn.onclick = async () => {
      if (!canEditOrDelete) return;
      const confirmDelete = confirm('Are you sure you want to delete this event?');
      if (!confirmDelete) return;

      try {
        await deleteEvent({ calendarId, id: event.id });
        allEventsMap[calendarId] = allEventsMap[calendarId].filter(ev => ev.id !== event.id);
        window.multiCalendar.getEventSourceById(calendarId)?.refetch();

        viewEventModal.hide();
        showToast("Deleted", "Event was successfully deleted.");
      } catch (err) {
        showError(`Failed to delete event: ${err.message}`);
      }
    };

    viewEventModal.show();
  }

  function renderReadOnlyChips(containerEl, items) {
    containerEl.innerHTML = '';
    items.forEach((item) => {
      const chip = document.createElement('span');
      chip.className = 'chip badge bg-secondary me-1';
      chip.textContent = item;
      containerEl.appendChild(chip);
    });
  }

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
      eventEndField,
      eventGuestsContainer,
      eventGuestsInput,
      toLocalDateTimeInput
    } = window;

    // NEW: find the room name
    const foundRoom = rooms.find(r => r.id === calendarId);
    const roomName  = foundRoom ? foundRoom.summary : "Unknown Room";
    const eventRoomNameField = document.getElementById('eventRoomName');
    if (eventRoomNameField) {
      eventRoomNameField.value = roomName;
    }

    // Set the color of the modal header
    const roomColor = roomColors[calendarId] || '#0d6efd';
    const modalHeader = document.querySelector('#eventModal .modal-header');
    modalHeader.classList.add('text-white');
    modalHeader.style.backgroundColor = roomColor;

    calendarIdField.value = calendarId || '';
    eventIdField.value    = eventId    || '';
    eventTitleField.value = title      || '';

    if (start) {
      eventStartField.value = toLocalDateTimeInput(new Date(start));
    } else {
      eventStartField.value = '';
    }
    if (end) {
      eventEndField.value = toLocalDateTimeInput(new Date(end));
    } else {
      eventEndField.value = '';
    }

    // Reset chips
    window.inviteChips = [];
    window.clearChipsUI();

    if (attendees && attendees.length > 0) {
      attendees.forEach((email) => {
        const userObj = window.prefetchedUsers.find(u => u.email === email);
        if (userObj) {
          window.addChip({
            label: `${userObj.name} <${userObj.email}>`,
            email: userObj.email
          });
        } else {
          window.addChip({ label: email, email });
        }
      });
      window.renderChipsUI();
    }

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
      inviteChips,
    } = window;

    const calendarId = calendarIdField.value;
    const eventId    = eventIdField.value;
    const title      = eventTitleField.value.trim();

    const localStart = new Date(eventStartField.value);
    const localEnd   = new Date(eventEndField.value);
    const startUTC   = localStart.toISOString();
    const endUTC     = localEnd.toISOString();

    if (!calendarId || !title) {
      showError('Missing required fields.');
      return;
    }

    const participants = inviteChips.map(ch => ch.email);

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
        await updateEvent({ calendarId, eventId, title, start: startUTC, end: endUTC, participants });
        showToast("Updated", "Event was successfully updated.");
      } else {
        // Creating new
        await createEvent({ calendarId, title, start: startUTC, end: endUTC, participants });
        showToast("Created", "Event was successfully created.");
      }
      await resyncSingleRoom(calendarId);
      window.multiCalendar.getEventSourceById(calendarId)?.refetch();

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
