/* ------------------------------------------------------------------
   calendar.js

   - Fix for the "first drag uses old ID" in resource mirror events.
   - We store the resource ID in 'selectAllow' so it's correct from the start.
   - Then 'eventDidMount' for the mirror references that global.
   - Finally, 'select' runs after the user finishes dragging.

   Also includes:
   - Non-resource real-time highlight hack for .fc-highlight
   - Resource-based mirror coloring (once)
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');
  if (!multiCalendarEl) {
    console.error("Could not find #multiCalendar element in the DOM.");
    return;
  }

  // Destructure helper methods from your calendar_helpers.js
  const {
    getFirstCheckedRoomId,
    getFirstCheckedRoomColor,
    doesOverlap,
    openEventModal,
    openViewEventModal,
    updateEvent,
    deleteEvent
  } = window.calendarHelpers;

  // Retrieve the last used view
  const savedView = localStorage.getItem('userSelectedView') || 'timeGridWeek';

  // Global variable that gets updated during drag
  window.currentMirrorResourceId = null;

  // Create the FullCalendar instance
  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    schedulerLicenseKey: 'GPL-My-Project-Is-Open-Source', // or your own key
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

    // By default, no mirror => non-resource views
    selectMirror: false,

    // Override for resource views
    views: {
      resourceTimeGridDay: {
        selectMirror: true
      },
      resourceTimeGridWeek: {
        selectMirror: true
      }
    },

    // Dynamically load the resources from your rooms
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

    // Merge events from each checked room
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

    /* ------------------------------------------------------------------
       1) SELECTALLOW => store resource ID in window.currentMirrorResourceId
          So the mirror event will see the correct ID from the start.
    ------------------------------------------------------------------ */
    selectAllow(selectInfo) {
      // If resource-based => store that ID
      if (selectInfo.resource) {
        window.currentMirrorResourceId = selectInfo.resource.id;
      } else {
        // Non-resource => fallback to first checked
        window.currentMirrorResourceId = getFirstCheckedRoomId();
      }
      // Also disallow selecting in the past, etc.
      return selectInfo.start >= new Date();
    },

    /* ------------------------------------------------------------------
       2) select => user finishes drag
          We create the event for whichever resource/room is stored
          in currentMirrorResourceId (or re-derive it if you prefer).
    ------------------------------------------------------------------ */
    select(info) {
      const chosenRoomId = window.currentMirrorResourceId;
      // Alternatively, you could do the same logic again:
      //   if (info.resource) { chosenRoomId = info.resource.id; } ...
      // but let's just trust selectAllow.

      if (!chosenRoomId) {
        window.showToast('Notice', 'No room selected.');
        window.multiCalendar.unselect();
        return;
      }

      // Overlap check
      const dummyEvent = { id: 'dummy', extendedProps: { realCalendarId: chosenRoomId } };
      if (doesOverlap(dummyEvent, info.start, info.end)) {
        window.showToast('Error', 'Time slot overlaps an existing event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      // Show the create-event modal
      openEventModal({
        calendarId: chosenRoomId,
        start: info.start,
        end:   info.end
      });
    },

    // dateClick => simpler "click to create" scenario (optional)
    dateClick(info) {
      // Usually overshadowed by "select" in resourceTimeGridDay
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

    /* ------------------------------------------------------------------
       3) eventDidMount => color the mirror event once
          Now that window.currentMirrorResourceId is set in selectAllow,
          The first drag will have the correct ID from the start.
    ------------------------------------------------------------------ */
    eventDidMount(info) {
      if (info.isMirror) {
        // Because resourceIds might be [], let's rely on currentMirrorResourceId
        const fallbackId = window.currentMirrorResourceId;
        if (fallbackId) {
          const color = window.roomColors[fallbackId] || '#666';
          info.el.style.backgroundColor = color;
          info.el.style.opacity = '0.8';
          info.el.style.color = '#fff';
        }
      }
    },

    // eventClick => open read-only event modal
    eventClick(info) {
      if (info.event._def && info.event._def.resourceIds) {
        console.log("Clicked event's resource IDs:", info.event._def.resourceIds);
      }
      const calendarId = info.event.extendedProps?.realCalendarId;
      if (!calendarId) return;
      openViewEventModal(info.event, calendarId);
    },

    // eventDrop => move an event
    eventDrop(info) {
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

    // eventResize => user extended/shortened an event
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

    // Fired after the calendar's view changes
    viewDidMount(args) {
      localStorage.setItem('userSelectedView', args.view.type);
    }
  });

  // Render the calendar
  window.multiCalendar.render();

  /* ------------------------------------------------------------------
     REAL-TIME HIGHLIGHT "HACK" FOR NON-RESOURCE VIEWS
  ------------------------------------------------------------------ */
  function colorHighlightEls() {
    const color = getFirstCheckedRoomColor();
    const highlights = document.querySelectorAll('.fc-highlight');
    highlights.forEach(el => {
      el.style.backgroundColor = color;
      el.style.opacity = '0.3';
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
}

/* Expose initCalendar to the global scope */
window.initCalendar = initCalendar;
