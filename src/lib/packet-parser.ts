/**
 * Custom packet parser for raw Virtio-Net Ethernet Frames
 * 
 * Intercepts net0-send packets to find UDP DNS requests (53) and TCP Web UI (54321) requests 
 * from inside the v86 Virtual Machine.
 */

export interface ParsedPacket {
  type: 'TCP' | 'UDP' | 'ICMP' | 'ETHERNET';
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  length: number;
  raw: Uint8Array;
}

export function parseEthernetFrame(data: Uint8Array): ParsedPacket | null {
  if (data.length < 14) return null; // Too small for standard Ethernet frame

  // Ethernet type
  const ethType = (data[12] << 8) | data[13];
  
  if (ethType !== 0x0800) {
    // We only care about IPv4 for this demo
    return {
      type: 'ETHERNET',
      srcIp: '0.0.0.0',
      dstIp: '0.0.0.0',
      srcPort: 0,
      dstPort: 0,
      length: data.length,
      raw: data
    };
  }

  // IP Header length (in 32-bit words)
  const ihl = data[14] & 0x0f;
  const protocol = data[23];
  
  const srcIp = [data[26], data[27], data[28], data[29]].join('.');
  const dstIp = [data[30], data[31], data[32], data[33]].join('.');

  let srcPort = 0;
  let dstPort = 0;

  // Offset where Transport Layer starts
  const offset = 14 + ihl * 4;

  if (protocol === 6 || protocol === 17) { // TCP or UDP
    if (data.length < offset + 4) return null;
    srcPort = (data[offset] << 8) | data[offset + 1];
    dstPort = (data[offset + 2] << 8) | data[offset + 3];
  }

  return {
    type: protocol === 6 ? 'TCP' : protocol === 17 ? 'UDP' : protocol === 1 ? 'ICMP' : 'ETHERNET',
    srcIp,
    dstIp,
    srcPort,
    dstPort,
    length: data.length,
    raw: data
  };
}
