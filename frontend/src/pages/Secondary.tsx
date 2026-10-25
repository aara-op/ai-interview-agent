import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { secondarySocketUrl } from "../api";

type State =
  | "starting"
  | "needs-permission"
  | "waiting"
  | "live"
  | "error";

export default function Secondary() {
  const { token } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sentOfferRef = useRef(false);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  const [state, setState] = useState<State>("starting");
  const [message, setMessage] = useState("");
  const [info, setInfo] = useState<{ candidate: string; role: string } | null>(null);

  const hangup = useCallback(() => {
    try {
      pcRef.current?.close();
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const negotiate = useCallback(async (ws: WebSocket, stream: MediaStream) => {
    if (sentOfferRef.current) return;
    sentOfferRef.current = true;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = (e) =>
        e.candidate &&
        ws.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "candidate", candidate: e.candidate }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription }));
      setState("live");
    } catch {
      sentOfferRef.current = false;
      setState("error");
      setMessage("Could not start the video stream on this device.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (!token) {
        setState("error");
        setMessage("Missing pairing code.");
        return;
      }

      // 1. validate the token before touching the camera
      let sessionId: number | null = null;
      try {
        const res = await fetch(`/api/pair/${encodeURIComponent(token)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setState("error");
          setMessage(String(body.detail ?? "This pairing link is invalid or expired."));
          return;
        }
        const data = await res.json();
        if (!data.consent_ok) {
          setState("error");
          setMessage("Proctoring consent has not been given for this interview.");
          return;
        }
        sessionId = data.session_id;
        setInfo({ candidate: data.candidate_name, role: data.interview_title });
      } catch {
        setState("error");
        setMessage("Could not reach the interview server.");
        return;
      }
      void sessionId;

      // 2. camera permission
      setState("needs-permission");
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("error");
        setMessage("This browser cannot open a camera. Use Chrome or Safari on http/https.");
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch {
          setState("error");
          setMessage(
            "Camera permission was denied. Open the site settings, allow the camera, then reload.",
          );
          return;
        }
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => undefined);
      }

      // 3. signalling + WebRTC
      setState("waiting");
      try {
        const ws = new WebSocket(secondarySocketUrl(token));
        wsRef.current = ws;

        ws.onopen = () => ws.send(JSON.stringify({ type: "join", role: "guest" }));

        ws.onmessage = async (raw) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(String(raw.data));
          } catch {
            return;
          }

          if (msg.type === "peers" && Number(msg.count) > 0) {
            void negotiate(ws, stream);
            return;
          }
          if (msg.type === "peer_joined") {
            void negotiate(ws, stream);
            return;
          }
          if (msg.type === "answer") {
            const pc = pcRef.current;
            if (!pc) return;
            await pc
              .setRemoteDescription(msg.sdp as RTCSessionDescriptionInit)
              .catch(() => undefined);
            for (const c of pendingIceRef.current.splice(0)) {
              await pc.addIceCandidate(c).catch(() => undefined);
            }
            return;
          }
          if (msg.type === "candidate") {
            const cand = msg.candidate as RTCIceCandidateInit;
            const pc = pcRef.current;
            if (!pc || !pc.remoteDescription) {
              pendingIceRef.current.push(cand);
              return;
            }
            await pc.addIceCandidate(cand).catch(() => undefined);
          }
        };

        ws.onclose = () => {
          if (!cancelled && state !== "live") setState("waiting");
        };
      } catch {
        setState("error");
        setMessage("Could not open the connection to the interview room.");
      }
    }

    boot();
    return () => {
      cancelled = true;
      hangup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Guarantee video element stays linked to camera stream
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => undefined);
    }
  });

  return (
    <div className="secondary-shell">
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="tiny dim" style={{ letterSpacing: ".1em" }}>
              SECONDARY CAMERA
            </div>
            <h1 style={{ fontSize: 21, marginTop: 4 }}>
              {info?.role ?? "Interview workspace view"}
            </h1>
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              {info?.candidate ?? ""}
            </p>
          </div>
          <span
            className={
              "badge " +
              (state === "live" ? "ok" : state === "error" ? "high" : "warn")
            }
          >
            {state === "live"
              ? "● live"
              : state === "waiting"
                ? "waiting"
                : state === "error"
                  ? "error"
                  : "starting"}
          </span>
        </div>
      </div>

      <div className="vtile" style={{ aspectRatio: "3 / 4", position: "relative" }}>
        <video
          ref={(el) => {
            (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
            if (el && streamRef.current && el.srcObject !== streamRef.current) {
              el.srcObject = streamRef.current;
              el.play().catch(() => undefined);
            }
          }}
          autoPlay
          playsInline
          muted
        />
        {state !== "live" && (
          <div
            className="placeholder"
            style={{
              background: state === "waiting" ? "rgba(5, 7, 15, 0.45)" : undefined,
              backdropFilter: state === "waiting" ? "blur(2px)" : undefined,
            }}
          >
            {state === "starting" && <div>Connecting…</div>}
            {state === "needs-permission" && <div>Allow camera access when prompted…</div>}
            {state === "waiting" && (
              <div style={{ textAlign: "center", padding: "10px 16px", borderRadius: 8, background: "rgba(0,0,0,0.65)" }}>
                <div style={{ fontWeight: 600, color: "#fff" }}>Camera connected locally ✓</div>
                <div className="tiny" style={{ color: "rgba(255,255,255,0.7)", marginTop: 4 }}>
                  Waiting for interview room to link feed…
                </div>
              </div>
            )}
            {state === "error" && <div>{message}</div>}
          </div>
        )}
        <div className="vlabel">
          <span
            className="dot"
            style={{ color: state === "live" ? "var(--ok)" : "var(--warn)" }}
          />
          Workspace camera
        </div>
      </div>

      {state === "error" ? (
        <div className="notice err">{message}</div>
      ) : (
        <div className="card">
          <h3>Placement & rules</h3>
          <ul className="rules">
            <li>
              Angle the phone so three things are in frame together: your
              laptop/desktop screen, the side of your face, and your desk setup.
            </li>
            <li>
              This side view lets the reviewer see where your eyes are pointing
              (screen vs. elsewhere) and what is on your desk.
            </li>
            <li>Keep the primary laptop camera on your face; this one shows your surroundings.</li>
            <li>Rest the phone against something stable — do not hold it.</li>
            <li>Keep this screen on and the app in the foreground for the whole interview.</li>
            <li>Close this page when the interview ends to stop sharing immediately.</li>
          </ul>
          <p className="tiny dim" style={{ marginBottom: 0 }}>
            Only this session's pairing code works, it expires when the interview
            finishes, and nothing is recorded until the recruiter has your consent.
          </p>
        </div>
      )}

      <button className="btn btn-danger btn-block" onClick={hangup}>
        Stop sharing now
      </button>
    </div>
  );
}
