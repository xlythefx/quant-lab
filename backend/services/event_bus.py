"""
Tiny indirection around the Flask-SocketIO instance so non-handler modules
(routes, background jobs) can emit without importing app.py.

app.py calls set_socketio(socketio) once at startup.
"""
_socketio = None


def set_socketio(s):
    global _socketio
    _socketio = s


def emit(event: str, payload, to=None):
    if _socketio is None:
        return
    if to:
        _socketio.emit(event, payload, to=to)
    else:
        _socketio.emit(event, payload)
