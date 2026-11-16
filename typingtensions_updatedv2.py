"""
crane_influx.py
===============
Single-crane UDP listener → InfluxDB v2.
Crane is selected by passing its ID as a command-line argument.

All fields from the crane UDP packet are forwarded to InfluxDB.
Only tag used: crane_id.

Usage:
    python crane_influx.py A210
    python crane_influx.py B210

Adding a new crane:
    1. Add an entry to CRANE_CONFIG below
    2. Open a new CMD window and run with the new crane ID
"""

import sys
import socket
import struct
import logging
import influxdb_client, os, time
from datetime import datetime, timezone

from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS

# ─────────────────────────────────────────────
#  CRANE CONFIG — add new cranes here
# ─────────────────────────────────────────────
CRANE_CONFIG = {
    "C210": 12257,  #added on 17.09
    "E208": 12247,  #added on 22.09
    "C207": 12245,  #added on 22.09  
    "A207": 12237,  #added on 07.10
    "C201": 12209,  #added on 07.10
    "C203": 12215,  #added on 07.10
    "A203": 12213,  #added on 09.10
    "A202": 12207,  #added on 09.10
    "E202": 12211,  #added on 26.10
}

# ─────────────────────────────────────────────
#  INFLUXDB CONNECTION
# ─────────────────────────────────────────────
INFLUX_URL    = 'http://192.168.100.218:8089/'
INFLUX_TOKEN  = "d2iesqomVeIx0NtZRNLwA5RsMjdRNM2RYu-PRG3sAOcn-enaG2HuZoRDqrkDphmadaAJ5Sa74KuZFJQb3o4lIQ=="
INFLUX_ORG    = "dpw"
INFLUX_BUCKET = "Crane_Telemetry"

# ─────────────────────────────────────────────

LISTEN_ADDRESS = "0.0.0.0"
BUFFER_SIZE    = 512


def build_point(crane_id: str, **fields) -> Point:
    p = (
        Point("crane_telemetry")
        .tag("crane_id", crane_id)
        .time(datetime.now(timezone.utc), "ms")
    )
    for name, val in fields.items():
        p = p.field(name, val)
    return p


def main():
    # ── Validate crane argument ───────────────────────────────────────────────
    if len(sys.argv) < 2:
        print(f"\nUsage:  python crane_influx.py <CRANE_ID>")
        print(f"Available cranes: {', '.join(CRANE_CONFIG.keys())}\n")
        sys.exit(1)

    crane_id = sys.argv[1].upper()
    if crane_id not in CRANE_CONFIG:
        print(f"\nUnknown crane '{crane_id}'.")
        print(f"Available cranes: {', '.join(CRANE_CONFIG.keys())}")
        print(f"Add it to CRANE_CONFIG in the script if needed.\n")
        sys.exit(1)

    udp_port = CRANE_CONFIG[crane_id]

    # ── Logging ───────────────────────────────────────────────────────────────
    logging.basicConfig(
        level=logging.INFO,
        format=f"%(asctime)s  [{crane_id}]  %(levelname)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    log = logging.getLogger(__name__)

    # ── Connect to InfluxDB ───────────────────────────────────────────────────
    log.info("Connecting to InfluxDB at %s  (org=%s  bucket=%s)",
             INFLUX_URL, INFLUX_ORG, INFLUX_BUCKET)
    client    = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
    write_api = client.write_api(write_options=SYNCHRONOUS)

    health = client.health()
    if health.status != "pass":
        log.error("InfluxDB health check FAILED: %s", health.message)
        sys.exit(1)
    log.info("Connection to InfluxDB successful")

    # ── Open UDP socket ───────────────────────────────────────────────────────
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((LISTEN_ADDRESS, udp_port))
    log.info("Listening on UDP port %d", udp_port)
    log.info("─" * 60)

    packets_received = 0
    packets_written  = 0

    try:
        while True:
            data, address = sock.recvfrom(BUFFER_SIZE)
            packets_received += 1
            log.info("UDP packet received from %s:%d (%d bytes)",
                     address[0], address[1], len(data))

            minimum_packet_size = 86 * 4
            if len(data) < minimum_packet_size:
                log.warning("Packet is too short: received %d bytes, need at least %d; skipping",
                            len(data), minimum_packet_size)
                continue

            try:

                # =========================================================
                # 0–71 : REAL VALUES (ConvertValArr)
                # =========================================================

                In_TRIM          = struct.unpack('>f', data[0*4:1*4])[0]
                In_LIST          = struct.unpack('>f', data[1*4:2*4])[0]
                In_SKEW          = struct.unpack('>f', data[2*4:3*4])[0]
                In_RT            = struct.unpack('>f', data[3*4:4*4])[0]
                In_RG            = struct.unpack('>f', data[4*4:5*4])[0]
                In_CYLINDER1     = struct.unpack('>f', data[5*4:6*4])[0]
                In_CYLINDER2     = struct.unpack('>f', data[6*4:7*4])[0]
                In_GANTRY1        = struct.unpack('>f', data[7*4:8*4])[0]
                GANTRYSPEED1      = struct.unpack('>f', data[8*4:9*4])[0]
                In_TROLLEYPOMUX  = struct.unpack('>f', data[9*4:10*4])[0]
                In_TROLLEYENC    = struct.unpack('>f', data[10*4:11*4])[0]
                TROLLEYSPEED1     = struct.unpack('>f', data[11*4:12*4])[0]
                In_HOIST         = struct.unpack('>f', data[12*4:13*4])[0]
                HOISTSPEED1       = struct.unpack('>f', data[13*4:14*4])[0]
                Gantry_obs_start       = struct.unpack('>f', data[14*4:15*4])[0]
                Gantry_obs_end       = struct.unpack('>f', data[15*4:16*4])[0]
                PLCTime          = data[16*4:83].decode(errors="replace").strip()# data[16*4:21*4]

                In_RIGHTLC       = struct.unpack('>f', data[21*4:22*4])[0]
                In_LEFTLC        = struct.unpack('>f', data[22*4:23*4])[0]
                In_NEARSLC       = struct.unpack('>f', data[23*4:24*4])[0]
                In_FARSLC        = struct.unpack('>f', data[24*4:25*4])[0]

                In_GANTRYCurrent1  = struct.unpack('>f', data[25*4:26*4])[0]
                In_GANTRYCurrent2  = struct.unpack('>f', data[26*4:27*4])[0]
                In_HOISTCurrent1   = struct.unpack('>f', data[27*4:28*4])[0]
                In_HOISTCurrent2   = struct.unpack('>f', data[28*4:29*4])[0]
                In_TROLLEYCurrent1 = struct.unpack('>f', data[29*4:30*4])[0]
                In_TROLLEYCurrent2 = struct.unpack('>f', data[30*4:31*4])[0]

                ControlState        = struct.unpack('>f', data[31*4:32*4])[0]
                HoistSpdLim         = struct.unpack('>f', data[32*4:33*4])[0]
                TrolleySpdLim       = struct.unpack('>f', data[33*4:34*4])[0]
                ConnectedDeskNo     = struct.unpack('>f', data[34*4:35*4])[0]

                # Replaced
                # Slot order follows the PLC (ConvertValArr[35..40])
                In_GANTRYVoltage1  = struct.unpack('>f', data[35*4:36*4])[0]
                In_GANTRYVoltage2  = struct.unpack('>f', data[36*4:37*4])[0]
                In_TROLLEYVoltage1 = struct.unpack('>f', data[37*4:38*4])[0]
                In_HOISTVoltage1   = struct.unpack('>f', data[38*4:39*4])[0]
                In_HOISTVoltage2   = struct.unpack('>f', data[39*4:40*4])[0]
                In_TROLLEYVoltage2 = struct.unpack('>f', data[40*4:41*4])[0]


                #Added
                # =========================================================
                # 41–42 : OTHER CRANES GANTRY POSITION (REAL)
                # =========================================================
                FwdCraneGantry = struct.unpack('>f', data[41*4:42*4])[0]
                BwdCraneGantry = struct.unpack('>f', data[42*4:43*4])[0]

                
                raw_container=data[51*4:54*4-1]
                ContainerID=raw_container.decode().rstrip()

                GANTRYSPEED2        = struct.unpack('>f', data[54*4:55*4])[0]
                HOISTSPEED2         = struct.unpack('>f', data[55*4:56*4])[0]
                TROLLEYSPEED2       = struct.unpack('>f', data[56*4:57*4])[0]
                GantryTorque1       = struct.unpack('>f', data[57*4:58*4])[0]
                GantryTorque2       = struct.unpack('>f', data[58*4:59*4])[0]
                HoistTorque1        = struct.unpack('>f', data[59*4:60*4])[0]
                HoistTorque2        = struct.unpack('>f', data[60*4:61*4])[0]
                TrolleyTorque1      = struct.unpack('>f', data[61*4:62*4])[0]
                TrolleyTorque2      = struct.unpack('>f', data[62*4:63*4])[0]
                
                # =========================================================
                # 32–71 : MORE REALS
                # =========================================================

                PCR_SpdRef       = struct.unpack('>f', data[63*4:64*4])[0]
                PCR_SpdActual    = struct.unpack('>f', data[64*4:65*4])[0]

                PCR_TorqueRef    = struct.unpack('>f', data[65*4:66*4])[0]
                PCR_TorqueAct    = struct.unpack('>f', data[66*4:67*4])[0]
                PCR_Current      = struct.unpack('>f', data[67*4:68*4])[0]

                In_GANTRY2        = struct.unpack('>f', data[68*4:69*4])[0]
                GantrySpdRef     = struct.unpack('>f', data[69*4:70*4])[0]
                GantrySpdLim     = struct.unpack('>f', data[70*4:71*4])[0]
                GantrySpdReq     = struct.unpack('>f', data[71*4:72*4])[0]

                # =========================================================
                # 72–83 : DINT AS REAL (CAST TO INT)
                # =========================================================

                WorkorderIdent   = int(struct.unpack('>I', data[72*4:73*4])[0])
                MoveType         = int(struct.unpack('>I', data[73*4:74*4])[0])
                LandingType      = int(struct.unpack('>I', data[74*4:75*4])[0])
                JobClearance     = int(struct.unpack('>I', data[75*4:76*4])[0])
                TargetType       = int(struct.unpack('>I', data[76*4:77*4])[0])
                ControlReject    = int(struct.unpack('>I', data[77*4:78*4])[0])

                GantryRef        = struct.unpack('>f', data[78*4:79*4])[0]
                TrolleyRef       = struct.unpack('>f', data[79*4:80*4])[0]
                HoistRef         = struct.unpack('>f', data[80*4:81*4])[0]

                Step             = int(struct.unpack('>I', data[81*4:82*4])[0])
                StepInfo         = int(struct.unpack('>I', data[82*4:83*4])[0])
                RemoteRequestInfo= int(struct.unpack('>I', data[83*4:84*4])[0])

                # =========================================================
                # 84 : STATUS DWORD
                # =========================================================

                StatusWord = struct.unpack('>I', data[84*4:85*4])[0]

                ControlON             = bool(StatusWord & (1 << 0))
                Spreader20ft          = bool(StatusWord & (1 << 1))
                Spreader40ft          = bool(StatusWord & (1 << 2))
                Spreader45ft          = bool(StatusWord & (1 << 3))
                SingleMode            = bool(StatusWord & (1 << 4))
                TwinMode              = bool(StatusWord & (1 << 5))
                LandedAllPins         = bool(StatusWord & (1 << 6))
                TwistlockLocked       = bool(StatusWord & (1 << 7))
                TwistlockUnlocked     = bool(StatusWord & (1 << 8))
                InnerLaneInPosition   = bool(StatusWord & (1 << 9))
                OuterLaneInPosition   = bool(StatusWord & (1 << 10))
                GantrySynchOk         = bool(StatusWord & (1 << 11))
                Gantry_obs_active     = bool(StatusWord & (1 << 12))
                AbortRequest          = bool(StatusWord & (1 << 13)) 

                #Added
                # --- Anti-collision (PLC already inverts: 1 = active) ---
                # Nearside = Landside, Farside = Waterside
                AntiCLandSrightPreStop   = bool(StatusWord & (1 << 14))
                AntiCLandSrightStop      = bool(StatusWord & (1 << 15))
                AntiCLandSrightWarning   = bool(StatusWord & (1 << 16))
                AntiCWaterSrightPreStop  = bool(StatusWord & (1 << 17))
                AntiCWaterSrightStop     = bool(StatusWord & (1 << 18))
                AntiCWaterSrightWarning  = bool(StatusWord & (1 << 19))
                AntiCLandSLeftPreStop    = bool(StatusWord & (1 << 20))
                AntiCLandSLeftStop       = bool(StatusWord & (1 << 21))
                AntiCLandSLeftWarning    = bool(StatusWord & (1 << 22))
                AntiCWaterSLeftPreStop   = bool(StatusWord & (1 << 23))
                AntiCWaterSLeftStop      = bool(StatusWord & (1 << 24))
                AntiCWaterSLeftWarning   = bool(StatusWord & (1 << 25))

                # --- Long-range anti-collision stop ---
                LongDLandSRight  = bool(StatusWord & (1 << 26))
                LongDLandSLeft   = bool(StatusWord & (1 << 27))
                LongDWaterSLeft  = bool(StatusWord & (1 << 28))
                LongDWaterSRight = bool(StatusWord & (1 << 29))

                # --- Gantry anti-collision latch (bits 30-31) ---
                AntiCGantryFwdLatch = bool(StatusWord & (1 << 30))
                AntiCGantryBwdLatch = bool(StatusWord & (1 << 31))

                # =========================================================
                # 85 : SECOND STATUS DWORD (BoolToDword1)
                # =========================================================

                StatusWord2 = struct.unpack('>I', data[85*4:86*4])[0]

                AutoActive = bool(StatusWord2 & (1 << 0))
                ManualIntervention = bool(StatusWord2 & (1 << 1))
                ForwardRequest = bool(StatusWord2 & (1 << 2))
                BackwardRequest = bool(StatusWord2 & (1 << 3))

                # =========================================================
                # WRITE TO INFLUXDB
                # =========================================================
                point = build_point(
                    crane_id,
                    PLCTime          = PLCTime,
                    # --- Spreader ---
                    In_TRIM          = In_TRIM,
                    In_LIST          = In_LIST,
                    In_SKEW          = In_SKEW,
                    In_RT            = In_RT,
                    In_RG            = In_RG,
                    In_CYLINDER1     = In_CYLINDER1,
                    In_CYLINDER2     = In_CYLINDER2,
                    # --- Gantry ---
                    In_GANTRY1        = In_GANTRY1,
                    GANTRYSPEED1      = GANTRYSPEED1,
                    GANTRYSPEED2      = GANTRYSPEED2,
                    GantryTorque1    = GantryTorque1,
                    GantryTorque2    = GantryTorque2,
                    
                    In_GANTRY2        = In_GANTRY2,
                    GantrySpdRef     = GantrySpdRef,
                    GantrySpdLim     = GantrySpdLim,
                    GantrySpdReq     = GantrySpdReq,
                    GantryRef        = GantryRef,
                    Gantry_obs_start =Gantry_obs_start,
                    Gantry_obs_end   =Gantry_obs_end,
                    # --- Trolley ---
                    In_TROLLEYPOMUX  = In_TROLLEYPOMUX,
                    In_TROLLEYENC    = In_TROLLEYENC,
                    TROLLEYSPEED1     = TROLLEYSPEED1,
                    TROLLEYSPEED2     = TROLLEYSPEED2,
                    TrolleyTorque1    = TrolleyTorque1,
                    TrolleyTorque2    = TrolleyTorque2,
                    TrolleyRef       = TrolleyRef,
                    TrolleySpdLim       =TrolleySpdLim,
                    # --- Hoist ---
                    In_HOIST         = In_HOIST,
                    HOISTSPEED1       = HOISTSPEED1,
                    HOISTSPEED2       = HOISTSPEED2,
                    HoistTorque1    = HoistTorque1,
                    HoistTorque2    = HoistTorque2,
                    HoistRef         = HoistRef,
                    HoistSpdLim     =HoistSpdLim,
                    # --- Load Cells ---
                    In_RIGHTLC       = In_RIGHTLC,
                    In_LEFTLC        = In_LEFTLC,
                    In_NEARSLC       = In_NEARSLC,
                    In_FARSLC        = In_FARSLC,
                    # --- Currents ---
                    In_GANTRYCurrent1  = In_GANTRYCurrent1,
                    In_GANTRYCurrent2  = In_GANTRYCurrent2,
                    In_HOISTCurrent1   = In_HOISTCurrent1,
                    In_HOISTCurrent2   = In_HOISTCurrent2,
                    In_TROLLEYCurrent1 = In_TROLLEYCurrent1,
                    In_TROLLEYCurrent2 = In_TROLLEYCurrent2,
                    # --- Voltage ---
                    
                    In_GANTRYVoltage1  = In_GANTRYVoltage1,
                    In_GANTRYVoltage2  = In_GANTRYVoltage2,
                    In_HOISTVoltage1   = In_HOISTVoltage1,
                    In_HOISTVoltage2   = In_HOISTVoltage2,
                    In_TROLLEYVoltage1 = In_TROLLEYVoltage1,
                    In_TROLLEYVoltage2 = In_TROLLEYVoltage2,
                    # --- Control ---
                    ControlState     = ControlState,
                    # --- PCR ---
                    PCR_SpdRef       = PCR_SpdRef,
                    PCR_SpdActual    = PCR_SpdActual,
                    PCR_TorqueRef    = PCR_TorqueRef,
                    PCR_TorqueAct    = PCR_TorqueAct,
                    PCR_Current      = PCR_Current,
                    # --- Job Info (int) ---
                    WorkorderIdent   = WorkorderIdent,
                    ContainerID      = ContainerID,
                    MoveType         = MoveType,
                    LandingType      = LandingType,
                    JobClearance     = JobClearance,
                    TargetType       = TargetType,
                    ControlReject    = ControlReject,
                    Step             = Step,
                    StepInfo         = StepInfo,
                    RemoteRequestInfo= RemoteRequestInfo,
                    ConnectedDeskNo = ConnectedDeskNo,
                    # --- Status Word ---
                    StatusWord       = StatusWord,
                    ControlON        = int(ControlON),
                    Spreader20ft     = int(Spreader20ft),
                    Spreader40ft     = int(Spreader40ft),
                    Spreader45ft     = int(Spreader45ft),
                    SingleMode       = int(SingleMode),
                    TwinMode         = int(TwinMode),
                    LandedAllPins    = int(LandedAllPins),
                    TwistlockLocked  = int(TwistlockLocked),
                    TwistlockUnlocked       = int(TwistlockUnlocked),
                    InnerLaneInPosition     = int(InnerLaneInPosition),
                    OuterLaneInPosition     = int(OuterLaneInPosition),
                    GantrySynchOk           = int(GantrySynchOk),
                    Gantry_obs_active       = int(Gantry_obs_active),
                    AbortRequest            = int(AbortRequest),

                    #Added
                    # --- Other cranes ---
                    FwdCraneGantry   = FwdCraneGantry,
                    BwdCraneGantry   = BwdCraneGantry,

                    # --- Anti-collision ---
                    AntiCLandSrightPreStop   = int(AntiCLandSrightPreStop),
                    AntiCLandSrightStop      = int(AntiCLandSrightStop),
                    AntiCLandSrightWarning   = int(AntiCLandSrightWarning),
                    AntiCWaterSrightPreStop  = int(AntiCWaterSrightPreStop),
                    AntiCWaterSrightStop     = int(AntiCWaterSrightStop),
                    AntiCWaterSrightWarning  = int(AntiCWaterSrightWarning),
                    AntiCLandSLeftPreStop    = int(AntiCLandSLeftPreStop),
                    AntiCLandSLeftStop       = int(AntiCLandSLeftStop),
                    AntiCLandSLeftWarning    = int(AntiCLandSLeftWarning),
                    AntiCWaterSLeftPreStop   = int(AntiCWaterSLeftPreStop),
                    AntiCWaterSLeftStop      = int(AntiCWaterSLeftStop),
                    AntiCWaterSLeftWarning   = int(AntiCWaterSLeftWarning),
                    # --- Long-range detection ---
                    LongDLandSRight  = int(LongDLandSRight),
                    LongDLandSLeft   = int(LongDLandSLeft),
                    LongDWaterSLeft  = int(LongDWaterSLeft),
                    LongDWaterSRight = int(LongDWaterSRight),

                    # --- Gantry anti-collision latch (bits 30-31) ---
                    AntiCGantryFwdLatch = int(AntiCGantryFwdLatch),
                    AntiCGantryBwdLatch = int(AntiCGantryBwdLatch),
                    
                    # --- Second Status Word ---
                    StatusWord2            = StatusWord2,
                    AutoActive             = int(AutoActive),
                    ManualIntervention     = int(ManualIntervention),
                    ForwardRequest         = int(ForwardRequest),
                    BackwardRequest        = int(BackwardRequest),

                )

                #print(point.to_line_protocol())
                write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=point)
                packets_written += 1

                log.info(
                    "✓ #%d | WO: %d | Step: %d | "
                    "In_GANTRY2: %7.2f | TrolleyRef: %7.2f | HoistRef: %7.2f | "
                    "Status: 0x%08X",
                    packets_written,
                    WorkorderIdent,
                    Step,
                    In_GANTRY2,
                    TrolleyRef,
                    HoistRef,
                    StatusWord,
                )

            except struct.error as exc:
                log.warning("Parse error (packet too short?): %s — skipping", exc)
            except Exception as exc:
                log.error("Write failed: %s", exc)

    except KeyboardInterrupt:
        log.info("Stopped.  Received: %d  |  Written to InfluxDB: %d",
                 packets_received, packets_written)
        client.close()


if __name__ == "__main__":
    main()
