import {
  CHIP_FAMILY_ESP32,
  CHIP_FAMILY_ESP32S2,
  CHIP_FAMILY_ESP32C3,
  CHIP_FAMILY_ESP8266,
  MAX_TIMEOUT,
  Logger,
  DEFAULT_TIMEOUT,
  ERASE_REGION_TIMEOUT_PER_MB,
  ESP_CHANGE_BAUDRATE,
  ESP_CHECKSUM_MAGIC,
  ESP_FLASH_BEGIN,
  ESP_FLASH_DATA,
  ESP_FLASH_END,
  ESP_MEM_BEGIN,
  ESP_MEM_DATA,
  ESP_MEM_END,
  ESP_READ_REG,
  ESP_WRITE_REG,
  ESP_SPI_ATTACH,
  ESP_SPI_SET_PARAMS,
  ESP_SYNC,
  FLASH_SECTOR_SIZE,
  FLASH_WRITE_SIZE,
  STUB_FLASH_WRITE_SIZE,
  MEM_END_ROM_TIMEOUT,
  ROM_INVALID_RECV_MSG,
  SYNC_PACKET,
  SYNC_TIMEOUT,
  USB_RAM_BLOCK,
  ChipFamily,
  ESP_ERASE_FLASH,
  CHIP_ERASE_TIMEOUT,
  timeoutPerMb,
  ESP_ROM_BAUD,
  ESP_FLASH_DEFL_BEGIN,
  ESP_FLASH_DEFL_DATA,
  ESP_FLASH_DEFL_END,
  ESP32_BOOTLOADER_FLASH_OFFSET,
  BOOTLOADER_FLASH_OFFSET,
  ESP_IMAGE_MAGIC,
  getFlashSizes,
  FLASH_FREQUENCIES,
  FLASH_MODES,
  getSpiFlashAddresses,
  SpiFlashAddresses,
  getUartDateRegAddress,
  DETECTED_FLASH_SIZES,
  CHIP_DETECT_MAGIC_REG_ADDR,
  CHIP_DETECT_MAGIC_VALUES,
} from "./const";
import { getStubCode } from "./stubs";
import { pack, sleep, slipEncode, toHex, unpack } from "./util";
// @ts-ignore
import { deflate } from "pako/dist/pako.esm.mjs";

export class ESPLoader extends EventTarget {
  chipFamily!: ChipFamily;
  chipName: string | null = null;
  _efuses = new Array(4).fill(0);
  _flashsize = 4 * 1024 * 1024;
  debug = false;
  IS_STUB = false;
  connected = true;
  flashSize: string | null = null;

  __inputBuffer?: number[];
  private _reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(
    public port: SerialPort,
    public logger: Logger,
    private _parent?: ESPLoader
  ) {
    super();
  }

  private get _inputBuffer(): number[] {
    return this._parent ? this._parent._inputBuffer : this.__inputBuffer!;
  }

  /**
   * @name chipType
   * ESP32 or ESP8266 based on which chip type we're talking to
   */
  async initialize() {
    await this.hardReset(true);

    if (!this._parent) {
      this.__inputBuffer = [];
      // Don't await this promise so it doesn't block rest of method.
      this.readLoop();
    }
    await this.sync();

    // Determine chip family and name
    let chipMagicValue = await this.readRegister(CHIP_DETECT_MAGIC_REG_ADDR);
    let chip = CHIP_DETECT_MAGIC_VALUES[chipMagicValue >>> 0];
    if (chip === undefined) {
      throw new Error(
        `Unknown Chip: Hex: ${toHex(
          chipMagicValue >>> 0,
          8
        ).toLowerCase()} Number: ${chipMagicValue}`
      );
    }
    this.chipName = chip.name;
    this.chipFamily = chip.family;

    // Read the OTP data for this chip and store into this.efuses array
    let baseAddr: number;
    if (this.chipFamily == CHIP_FAMILY_ESP8266) {
      baseAddr = 0x3ff00050;
    } else if (this.chipFamily == CHIP_FAMILY_ESP32) {
      baseAddr = 0x3ff5a000;
    } else if (this.chipFamily == CHIP_FAMILY_ESP32S2) {
      baseAddr = 0x3f41a000;
    } else if (this.chipFamily == CHIP_FAMILY_ESP32C3) {
      baseAddr = 0x60008800;
    }
    for (let i = 0; i < 4; i++) {
      this._efuses[i] = await this.readRegister(baseAddr! + 4 * i);
    }
    this.logger.log(`Chip type ${this.chipName}`);

    // if (this._efuses[0] & (1 << 4) || this._efuses[2] & (1 << 16)) {
    //   this.chipName = "ESP8285";
    // } else {
    //   this.chipName = "ESP8266EX";
    // }

    //this.logger.log("FLASHID");
  }

  /**
   * @name readLoop
   * Reads data from the input stream and places it in the inputBuffer
   */
  async readLoop() {
    this.logger.debug("Starting read loop");

    this._reader = this.port.readable!.getReader();

    try {
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) {
          this._reader.releaseLock();
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }
        this._inputBuffer.push(...Array.from(value));
      }
    } catch (err) {
      console.error("Read loop got disconnected");
      // Disconnected!
      this.connected = false;
      this.dispatchEvent(new Event("disconnect"));
    }
    this.logger.debug("Finished read loop");
  }

  async hardReset(bootloader = false) {
    this.logger.log("Try hard reset.");
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: true,
    });
    await this.port.setSignals({
      dataTerminalReady: bootloader,
      requestToSend: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  /**
   * @name macAddr
   * The MAC address burned into the OTP memory of the ESP chip
   */
  macAddr() {
    let macAddr = new Array(6).fill(0);
    let mac0 = this._efuses[0];
    let mac1 = this._efuses[1];
    let mac2 = this._efuses[2];
    let mac3 = this._efuses[3];
    let oui;
    if (this.chipFamily == CHIP_FAMILY_ESP8266) {
      if (mac3 != 0) {
        oui = [(mac3 >> 16) & 0xff, (mac3 >> 8) & 0xff, mac3 & 0xff];
      } else if (((mac1 >> 16) & 0xff) == 0) {
        oui = [0x18, 0xfe, 0x34];
      } else if (((mac1 >> 16) & 0xff) == 1) {
        oui = [0xac, 0xd0, 0x74];
      } else {
        throw new Error("Couldnt determine OUI");
      }

      macAddr[0] = oui[0];
      macAddr[1] = oui[1];
      macAddr[2] = oui[2];
      macAddr[3] = (mac1 >> 8) & 0xff;
      macAddr[4] = mac1 & 0xff;
      macAddr[5] = (mac0 >> 24) & 0xff;
    } else if (this.chipFamily == CHIP_FAMILY_ESP32) {
      macAddr[0] = (mac2 >> 8) & 0xff;
      macAddr[1] = mac2 & 0xff;
      macAddr[2] = (mac1 >> 24) & 0xff;
      macAddr[3] = (mac1 >> 16) & 0xff;
      macAddr[4] = (mac1 >> 8) & 0xff;
      macAddr[5] = mac1 & 0xff;
    } else if (this.chipFamily == CHIP_FAMILY_ESP32S2) {
      macAddr[0] = (mac2 >> 8) & 0xff;
      macAddr[1] = mac2 & 0xff;
      macAddr[2] = (mac1 >> 24) & 0xff;
      macAddr[3] = (mac1 >> 16) & 0xff;
      macAddr[4] = (mac1 >> 8) & 0xff;
      macAddr[5] = mac1 & 0xff;
    } else if (this.chipFamily == CHIP_FAMILY_ESP32C3) {
      macAddr[0] = (mac2 >> 8) & 0xff;
      macAddr[1] = mac2 & 0xff;
      macAddr[2] = (mac1 >> 24) & 0xff;
      macAddr[3] = (mac1 >> 16) & 0xff;
      macAddr[4] = (mac1 >> 8) & 0xff;
      macAddr[5] = mac1 & 0xff;
    } else {
      throw new Error("Unknown chip family");
    }
    return macAddr;
  }

  /**
   * @name readRegister
   * Read a register within the ESP chip RAM, returns a 4-element list
   */
  async readRegister(reg: number) {
    if (this.debug) {
      this.logger.debug("Reading Register", reg);
    }
    let packet = pack("I", reg);
    let register = (await this.checkCommand(ESP_READ_REG, packet))[0];
    return unpack("I", register!)[0];
  }

  /**
   * @name checkCommand
   * Send a command packet, check that the command succeeded and
   * return a tuple with the value and data.
   * See the ESP Serial Protocol for more details on what value/data are
   */
  async checkCommand(
    opcode: number,
    buffer: number[],
    checksum = 0,
    timeout = DEFAULT_TIMEOUT
  ) {
    timeout = Math.min(timeout, MAX_TIMEOUT);
    await this.sendCommand(opcode, buffer, checksum);
    let [value, data] = await this.getResponse(opcode, timeout);

    if (data === null) {
      throw new Error("Didn't get enough status bytes");
    }

    let statusLen = 0;

    if (this.IS_STUB || this.chipFamily == CHIP_FAMILY_ESP8266) {
      statusLen = 2;
    } else if (
      [CHIP_FAMILY_ESP32, CHIP_FAMILY_ESP32S2, CHIP_FAMILY_ESP32C3].includes(
        this.chipFamily
      )
    ) {
      statusLen = 4;
    } else {
      if ([2, 4].includes(data.length)) {
        statusLen = data.length;
      }
    }

    if (data.length < statusLen) {
      throw new Error("Didn't get enough status bytes");
    }
    let status = data.slice(-statusLen, data.length);
    data = data.slice(0, -statusLen);
    if (this.debug) {
      this.logger.debug("status", status);
      this.logger.debug("value", value);
      this.logger.debug("data", data);
    }
    if (status[0] == 1) {
      if (status[1] == ROM_INVALID_RECV_MSG) {
        throw new Error("Invalid (unsupported) command " + toHex(opcode));
      } else {
        throw new Error("Command failure error code " + toHex(status[1]));
      }
    }
    return [value, data];
  }

  /**
   * @name sendCommand
   * Send a slip-encoded, checksummed command over the UART,
   * does not check response
   */
  async sendCommand(opcode: number, buffer: number[], checksum = 0) {
    //debugMsg("Running Send Command");
    this._inputBuffer.length = 0; // Reset input buffer
    let packet = [0xc0, 0x00]; // direction
    packet.push(opcode);
    packet = packet.concat(pack("H", buffer.length));
    packet = packet.concat(slipEncode(pack("I", checksum)));
    packet = packet.concat(slipEncode(buffer));
    packet.push(0xc0);
    if (this.debug) {
      this.logger.debug(
        "Writing " +
          packet.length +
          " byte" +
          (packet.length == 1 ? "" : "s") +
          ":",
        packet
      );
    }
    await this.writeToStream(packet);
  }

  /**
   * @name getResponse
   * Read response data and decodes the slip packet, then parses
   * out the value/data and returns as a tuple of (value, data) where
   * each is a list of bytes
   */
  async getResponse(opcode: number, timeout = DEFAULT_TIMEOUT) {
    let reply: number[] = [];
    let packetLength = 0;
    let escapedByte = false;
    let stamp = Date.now();
    while (Date.now() - stamp < timeout) {
      if (this._inputBuffer.length > 0) {
        let c = this._inputBuffer.shift()!;
        if (c == 0xdb) {
          escapedByte = true;
        } else if (escapedByte) {
          if (c == 0xdd) {
            reply.push(0xdc);
          } else if (c == 0xdc) {
            reply.push(0xc0);
          } else {
            reply = reply.concat([0xdb, c]);
          }
          escapedByte = false;
        } else {
          reply.push(c);
        }
      } else {
        await sleep(10);
      }
      if (reply.length > 0 && reply[0] != 0xc0) {
        // packets must start with 0xC0
        reply.shift();
      }
      if (reply.length > 1 && reply[1] != 0x01) {
        reply.shift();
      }
      if (reply.length > 2 && reply[2] != opcode) {
        reply.shift();
      }
      if (reply.length > 4) {
        // get the length
        packetLength = reply[3] + (reply[4] << 8);
      }
      if (reply.length == packetLength + 10) {
        break;
      }
    }

    // Check to see if we have a complete packet. If not, we timed out.
    if (reply.length != packetLength + 10) {
      this.logger.log("Timed out after " + timeout + " milliseconds");
      return [null, null];
    }
    if (this.debug) {
      this.logger.debug(
        "Reading " +
          reply.length +
          " byte" +
          (reply.length == 1 ? "" : "s") +
          ":",
        reply
      );
    }
    let value = reply.slice(5, 9);
    let data = reply.slice(9, -1);
    if (this.debug) {
      this.logger.debug("value:", value, "data:", data);
    }
    return [value, data];
  }

  /**
   * @name read
   * Read response data and decodes the slip packet.
   * Keeps reading until we hit the timeout or get
   * a packet closing byte
   */
  async readBuffer(timeout = DEFAULT_TIMEOUT) {
    let reply: number[] = [];
    // let packetLength = 0;
    let escapedByte = false;
    let stamp = Date.now();
    while (Date.now() - stamp < timeout) {
      if (this._inputBuffer.length > 0) {
        let c = this._inputBuffer.shift()!;
        if (c == 0xdb) {
          escapedByte = true;
        } else if (escapedByte) {
          if (c == 0xdd) {
            reply.push(0xdc);
          } else if (c == 0xdc) {
            reply.push(0xc0);
          } else {
            reply = reply.concat([0xdb, c]);
          }
          escapedByte = false;
        } else {
          reply.push(c);
        }
      } else {
        await sleep(10);
      }
      if (reply.length > 0 && reply[0] != 0xc0) {
        // packets must start with 0xC0
        reply.shift();
      }
      if (reply.length > 1 && reply[reply.length - 1] == 0xc0) {
        break;
      }
    }

    // Check to see if we have a complete packet. If not, we timed out.
    if (reply.length < 2) {
      this.logger.log("Timed out after " + timeout + " milliseconds");
      return null;
    }
    if (this.debug) {
      this.logger.debug(
        "Reading " +
          reply.length +
          " byte" +
          (reply.length == 1 ? "" : "s") +
          ":",
        reply
      );
    }
    let data = reply.slice(1, -1);
    if (this.debug) {
      this.logger.debug("data:", data);
    }
    return data;
  }

  /**
   * @name checksum
   * Calculate checksum of a blob, as it is defined by the ROM
   */
  checksum(data: number[], state = ESP_CHECKSUM_MAGIC) {
    for (let b of data) {
      state ^= b;
    }
    return state;
  }

  async setBaudrate(baud: number) {
    if (this.chipFamily == CHIP_FAMILY_ESP8266) {
      throw new Error("Changing baud rate is not supported on the ESP8266");
    }

    this.logger.log("Attempting to change baud rate to " + baud + "...");

    try {
      // Send ESP_ROM_BAUD(115200) as the old one if running STUB otherwise 0
      let buffer = pack("<II", baud, this.IS_STUB ? ESP_ROM_BAUD : 0);
      await this.checkCommand(ESP_CHANGE_BAUDRATE, buffer);
    } catch (e) {
      console.error(e);
      throw new Error(
        `Unable to change the baud rate to ${baud}: No response from set baud rate command.`
      );
    }

    if (this._parent) {
      await this._parent.reconfigurePort(baud);
    } else {
      await this.reconfigurePort(baud);
    }
  }

  async reconfigurePort(baud: number) {
    try {
      // SerialPort does not allow to be reconfigured while open so we close and re-open
      // reader.cancel() causes the Promise returned by the read() operation running on
      // the readLoop to return immediately with { value: undefined, done: true } and thus
      // breaking the loop and exiting readLoop();
      await this._reader?.cancel();
      await this.port.close();

      // Reopen Port
      await this.port.open({ baudRate: baud });

      // Restart Readloop
      this.readLoop();

      this.logger.log(`Changed baud rate to ${baud}`);
    } catch (e) {
      console.error(e);
      throw new Error(`Unable to change the baud rate to ${baud}: ${e}`);
    }
  }

  /**
   * @name sync
   * Put into ROM bootload mode & attempt to synchronize with the
   * ESP ROM bootloader, we will retry a few times
   */
  async sync() {
    for (let i = 0; i < 5; i++) {
      let response = await this._sync();
      if (response) {
        await sleep(100);
        return true;
      }
      await sleep(100);
    }

    throw new Error("Couldn't sync to ESP. Try resetting.");
  }

  /**
   * @name _sync
   * Perform a soft-sync using AT sync packets, does not perform
   * any hardware resetting
   */
  async _sync() {
    await this.sendCommand(ESP_SYNC, SYNC_PACKET);
    for (let i = 0; i < 8; i++) {
      let [_reply, data] = await this.getResponse(ESP_SYNC, SYNC_TIMEOUT);
      if (data === null) {
        continue;
      }
      if (data.length > 1 && data[0] == 0 && data[1] == 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * @name getFlashWriteSize
   * Get the Flash write size based on the chip
   */
  getFlashWriteSize() {
    if (this.IS_STUB) {
      return STUB_FLASH_WRITE_SIZE;
    }
    return FLASH_WRITE_SIZE;
  }

  /**
   * @name flashData
   * Program a full, uncompressed binary file into SPI Flash at
   *   a given offset. If an ESP32 and md5 string is passed in, will also
   *   verify memory. ESP8266 does not have checksum memory verification in
   *   ROM
   */
  async flashData(
    binaryData: ArrayBuffer,
    updateProgress: (bytesWritten: number, totalBytes: number) => void,
    offset = 0,
    compress = false
  ) {
    this.updateImageFlashParams(offset, binaryData);
    let uncompressedFilesize = binaryData.byteLength;
    let compressedFilesize = 0;

    let dataToFlash;

    if (compress) {
      dataToFlash = deflate(new Uint8Array(binaryData), {
        level: 9,
      }).buffer;
      compressedFilesize = dataToFlash.byteLength;
      this.logger.log(
        `Writing data with filesize: ${uncompressedFilesize}. Compressed Size: ${compressedFilesize}`
      );
      await this.flashDeflBegin(
        uncompressedFilesize,
        compressedFilesize,
        offset
      );
    } else {
      this.logger.log(`Writing data with filesize: ${uncompressedFilesize}`);
      dataToFlash = binaryData;
      await this.flashBegin(uncompressedFilesize, offset);
    }

    let block = [];
    let seq = 0;
    let written = 0;
    let position = 0;
    let stamp = Date.now();
    let flashWriteSize = this.getFlashWriteSize();

    let filesize = compress ? compressedFilesize : uncompressedFilesize;

    while (filesize - position > 0) {
      if (this.debug) {
        this.logger.log(
          `Writing at ${toHex(offset + seq * flashWriteSize, 8)} `
        );
      }
      if (filesize - position >= flashWriteSize) {
        block = Array.from(
          new Uint8Array(dataToFlash, position, flashWriteSize)
        );
      } else {
        // Pad the last block only if we are sending uncompressed data.
        block = Array.from(
          new Uint8Array(dataToFlash, position, filesize - position)
        );
        if (!compress) {
          block = block.concat(
            new Array(flashWriteSize - block.length).fill(0xff)
          );
        }
      }
      if (compress) {
        await this.flashDeflBlock(block, seq, 2000);
      } else {
        await this.flashBlock(block, seq, 2000);
      }
      seq += 1;
      // If using compression we update the progress with the proportional size of the block taking into account the compression ratio.
      // This way we report progress on the uncompressed size
      written += compress
        ? Math.round((block.length * uncompressedFilesize) / compressedFilesize)
        : block.length;
      position += flashWriteSize;
      updateProgress(written, filesize);
    }
    this.logger.log(
      "Took " + (Date.now() - stamp) + "ms to write " + filesize + " bytes"
    );

    // Only send flashF finish if running the stub because ir causes the ROM to exit and run user code
    if (this.IS_STUB) {
      await this.flashBegin(0, 0);
      if (compress) {
        await this.flashDeflFinish();
      } else {
        await this.flashFinish();
      }
    }
  }

  /**
   * @name flashBlock
   * Send one block of data to program into SPI Flash memory
   */
  async flashBlock(data: number[], seq: number, timeout = SYNC_TIMEOUT) {
    await this.checkCommand(
      ESP_FLASH_DATA,
      pack("<IIII", data.length, seq, 0, 0).concat(data),
      this.checksum(data),
      timeout
    );
  }
  async flashDeflBlock(data: number[], seq: number, timeout = SYNC_TIMEOUT) {
    await this.checkCommand(
      ESP_FLASH_DEFL_DATA,
      pack("<IIII", data.length, seq, 0, 0).concat(data),
      this.checksum(data)
    );
  }

  /**
   * @name flashBegin
   * Prepare for flashing by attaching SPI chip and erasing the
   *   number of blocks requred.
   */
  async flashBegin(size = 0, offset = 0, encrypted = false) {
    let eraseSize;
    let buffer;
    let flashWriteSize = this.getFlashWriteSize();
    if (
      [CHIP_FAMILY_ESP32, CHIP_FAMILY_ESP32S2, CHIP_FAMILY_ESP32C3].includes(
        this.chipFamily
      )
    ) {
      await this.checkCommand(ESP_SPI_ATTACH, new Array(8).fill(0));
    }
    if (this.chipFamily == CHIP_FAMILY_ESP32) {
      // We are hardcoded for 4MB flash on ESP32
      buffer = pack("<IIIIII", 0, this._flashsize, 0x10000, 4096, 256, 0xffff);
      await this.checkCommand(ESP_SPI_SET_PARAMS, buffer);
    }
    let numBlocks = Math.floor((size + flashWriteSize - 1) / flashWriteSize);
    if (this.chipFamily == CHIP_FAMILY_ESP8266) {
      eraseSize = this.getEraseSize(offset, size);
    } else {
      eraseSize = size;
    }

    let timeout;
    if (this.IS_STUB) {
      timeout = DEFAULT_TIMEOUT;
    } else {
      timeout = timeoutPerMb(ERASE_REGION_TIMEOUT_PER_MB, size);
    }

    let stamp = Date.now();
    buffer = pack("<IIII", eraseSize, numBlocks, flashWriteSize, offset);
    if (this.chipFamily == CHIP_FAMILY_ESP32S2) {
      buffer = buffer.concat(pack("<I", encrypted ? 1 : 0));
    }
    if (this.chipFamily == CHIP_FAMILY_ESP32C3) {
      buffer = buffer.concat(pack("<I", encrypted ? 1 : 0));
    }
    this.logger.log(
      "Erase size " +
        eraseSize +
        ", blocks " +
        numBlocks +
        ", block size " +
        flashWriteSize +
        ", offset " +
        toHex(offset, 4) +
        ", encrypted " +
        (encrypted ? "yes" : "no")
    );
    await this.checkCommand(ESP_FLASH_BEGIN, buffer, 0, timeout);
    if (size != 0 && !this.IS_STUB) {
      this.logger.log(
        "Took " + (Date.now() - stamp) + "ms to erase " + numBlocks + " bytes"
      );
    }
    return numBlocks;
  }

  /**
   * @name flashDeflBegin
   *
   */

  async flashDeflBegin(
    size = 0,
    compressedSize = 0,
    offset = 0,
    encrypted = false
  ) {
    // Start downloading compressed data to Flash (performs an erase)
    // Returns number of blocks to write.
    let flashWriteSize = this.getFlashWriteSize();
    let numBlocks = Math.floor(
      (compressedSize + flashWriteSize - 1) / flashWriteSize
    );
    let eraseBlocks = Math.floor((size + flashWriteSize - 1) / flashWriteSize);
    let writeSize = 0;
    let timeout = 0;
    let buffer;

    if (this.IS_STUB) {
      writeSize = size; // stub expects number of bytes here, manages erasing internally
      timeout = DEFAULT_TIMEOUT;
    } else {
      writeSize = eraseBlocks * flashWriteSize; // ROM expects rounded up to erase block size
      timeout = timeoutPerMb(ERASE_REGION_TIMEOUT_PER_MB, writeSize); // ROM performs the erase up front
    }
    buffer = pack("<IIII", writeSize, numBlocks, flashWriteSize, offset);

    await this.checkCommand(ESP_FLASH_DEFL_BEGIN, buffer, 0, timeout);

    return numBlocks;
  }

  async flashFinish() {
    let buffer = pack("<I", 1);
    await this.checkCommand(ESP_FLASH_END, buffer);
  }

  async flashDeflFinish() {
    let buffer = pack("<I", 1);
    await this.checkCommand(ESP_FLASH_DEFL_END, buffer);
  }

  getBootloaderOffset() {
    if (
      this.chipFamily == CHIP_FAMILY_ESP32 ||
      this._parent?.chipFamily == CHIP_FAMILY_ESP32
    ) {
      return ESP32_BOOTLOADER_FLASH_OFFSET;
    }
    return BOOTLOADER_FLASH_OFFSET;
  }

  updateImageFlashParams(offset: number, image: ArrayBuffer) {
    // Modify the flash mode & size bytes if this looks like an executable bootloader image
    if (image.byteLength < 8) {
      return image; //# not long enough to be a bootloader image
    }

    // unpack the (potential) image header

    var header = Array.from(new Uint8Array(image, 0, 4));
    let headerMagic = header[0];
    let headerFlashMode = header[2];
    let heatherFlashSizeFreq = header[3];

    this.logger.debug(
      `Image header, Magic=${toHex(headerMagic)}, FlashMode=${toHex(
        headerFlashMode
      )}, FlashSizeFreq=${toHex(heatherFlashSizeFreq)}`
    );

    if (offset != this.getBootloaderOffset()) {
      return image; // not flashing bootloader offset, so don't modify this image
    }

    // easy check if this is an image: does it start with a magic byte?
    if (headerMagic != ESP_IMAGE_MAGIC) {
      this.logger.log(
        "Warning: Image file at %s doesn't look like an image file, so not changing any flash settings.",
        toHex(offset, 4)
      );
      return image;
    }

    // make sure this really is an image, and not just data that
    // starts with esp.ESP_IMAGE_MAGIC (mostly a problem for encrypted
    // images that happen to start with a magic byte

    // TODO Implement this test from esptool.py
    /*
    try:
        test_image = esp.BOOTLOADER_IMAGE(io.BytesIO(image))
        test_image.verify()
    except Exception:
        print("Warning: Image file at 0x%x is not a valid %s image, so not changing any flash settings." % (address, esp.CHIP_NAME))
        return image
    */

    this.logger.log("Image being flashed is a bootloader");

    // For now we always select dio, a common value supported by many flash chips and ESP boards
    let flashMode = FLASH_MODES["dio"];
    // For now we always select 40m, a common value supported by many flash chips and ESP boards
    let flashFreq = FLASH_FREQUENCIES["40m"];
    let flashSize = getFlashSizes(this.getChipFamily())[
      this.flashSize ? this.flashSize : "4MB"
    ]; // If size was autodetected we use it otherwise we default to 4MB
    let flashParams = pack("BB", flashMode, flashSize + flashFreq);
    let imageFlashParams = new Uint8Array(image, 2, 2);

    if (
      flashParams[0] != imageFlashParams[0] ||
      flashParams[1] != imageFlashParams[1]
    ) {
      imageFlashParams[0] = flashParams[0];
      imageFlashParams[1] = flashParams[1];

      this.logger.log(
        `Patching Flash parameters header bytes to ${toHex(
          flashParams[0],
          2
        )} ${toHex(flashParams[1], 2)}`
      );
    } else {
      this.logger.log("Flash parameters header did not need patching.");
    }
    return image;
  }

  async flashId() {
    let SPIFLASH_RDID = 0x9f;
    let result = await this.runSpiFlashCommand(SPIFLASH_RDID, [], 24);
    return result;
  }

  getChipFamily() {
    return this._parent ? this._parent.chipFamily : this.chipFamily;
  }

  async writeRegister(
    address: number,
    value: number,
    mask = 0xffffffff,
    delayUs = 0,
    delayAfterUs = 0
  ) {
    let buffer = pack("<IIII", address, value, mask, delayUs);
    if (delayAfterUs > 0) {
      // add a dummy write to a date register as an excuse to have a delay
      buffer.concat(
        pack(
          "<IIII",
          getUartDateRegAddress(this.getChipFamily()),
          0,
          0,
          delayAfterUs
        )
      );
    }
    await this.checkCommand(ESP_WRITE_REG, buffer);
  }

  async setDataLengths(
    spiAddresses: SpiFlashAddresses,
    mosiBits: number,
    misoBits: number
  ) {
    if (spiAddresses.mosiDlenOffs != -1) {
      // ESP32/32S2/32C3 has a more sophisticated way to set up "user" commands
      let SPI_MOSI_DLEN_REG = spiAddresses.regBase + spiAddresses.mosiDlenOffs;
      let SPI_MISO_DLEN_REG = spiAddresses.regBase + spiAddresses.misoDlenOffs;
      if (mosiBits > 0) {
        await this.writeRegister(SPI_MOSI_DLEN_REG, mosiBits - 1);
      }
      if (misoBits > 0) {
        await this.writeRegister(SPI_MISO_DLEN_REG, misoBits - 1);
      }
    } else {
      let SPI_DATA_LEN_REG = spiAddresses.regBase + spiAddresses.usr1Offs;
      let SPI_MOSI_BITLEN_S = 17;
      let SPI_MISO_BITLEN_S = 8;
      let mosiMask = mosiBits == 0 ? 0 : mosiBits - 1;
      let misoMask = misoBits == 0 ? 0 : misoBits - 1;
      let value =
        (misoMask << SPI_MISO_BITLEN_S) | (mosiMask << SPI_MOSI_BITLEN_S);
      await this.writeRegister(SPI_DATA_LEN_REG, value);
    }
  }
  async waitDone(spiCmdReg: number, spiCmdUsr: number) {
    for (let i = 0; i < 10; i++) {
      let cmdValue = await this.readRegister(spiCmdReg);
      if ((cmdValue & spiCmdUsr) == 0) {
        return;
      }
    }
    throw Error("SPI command did not complete in time");
  }

  async runSpiFlashCommand(
    spiflashCommand: number,
    data: number[],
    readBits = 0
  ) {
    // Run an arbitrary SPI flash command.

    // This function uses the "USR_COMMAND" functionality in the ESP
    // SPI hardware, rather than the precanned commands supported by
    // hardware. So the value of spiflash_command is an actual command
    // byte, sent over the wire.

    // After writing command byte, writes 'data' to MOSI and then
    // reads back 'read_bits' of reply on MISO. Result is a number.

    // SPI_USR register flags
    let SPI_USR_COMMAND = 1 << 31;
    let SPI_USR_MISO = 1 << 28;
    let SPI_USR_MOSI = 1 << 27;

    // SPI registers, base address differs ESP32* vs 8266
    let spiAddresses = getSpiFlashAddresses(this.getChipFamily());
    let base = spiAddresses.regBase;
    let SPI_CMD_REG = base + 0x00;
    let SPI_USR_REG = base + spiAddresses.usrOffs;
    let SPI_USR2_REG = base + spiAddresses.usr2Offs;
    let SPI_W0_REG = base + spiAddresses.w0Offs;

    // SPI peripheral "command" bitmasks for SPI_CMD_REG
    let SPI_CMD_USR = 1 << 18;

    // shift values
    let SPI_USR2_COMMAND_LEN_SHIFT = 28;

    if (readBits > 32) {
      throw new Error(
        "Reading more than 32 bits back from a SPI flash operation is unsupported"
      );
    }
    if (data.length > 64) {
      throw new Error(
        "Writing more than 64 bytes of data with one SPI command is unsupported"
      );
    }

    let dataBits = data.length * 8;
    let oldSpiUsr = await this.readRegister(SPI_USR_REG);
    let oldSpiUsr2 = await this.readRegister(SPI_USR2_REG);

    let flags = SPI_USR_COMMAND;

    if (readBits > 0) {
      flags |= SPI_USR_MISO;
    }
    if (dataBits > 0) {
      flags |= SPI_USR_MOSI;
    }

    await this.setDataLengths(spiAddresses, dataBits, readBits);

    await this.writeRegister(SPI_USR_REG, flags);
    await this.writeRegister(
      SPI_USR2_REG,
      (7 << SPI_USR2_COMMAND_LEN_SHIFT) | spiflashCommand
    );
    if (dataBits == 0) {
      await this.writeRegister(SPI_W0_REG, 0); // clear data register before we read it
    } else {
      data.concat(new Array(data.length % 4).fill(0x00)); // pad to 32-bit multiple

      let words = unpack("I".repeat(Math.floor(data.length / 4)), data);
      let nextReg = SPI_W0_REG;

      this.logger.debug(`Words Length: ${words.length}`);

      for (const word of words) {
        this.logger.debug(
          `Writing word ${toHex(word)} to register offset ${toHex(nextReg)}`
        );
        await this.writeRegister(nextReg, word);
        nextReg += 4;
      }
    }
    await this.writeRegister(SPI_CMD_REG, SPI_CMD_USR);
    await this.waitDone(SPI_CMD_REG, SPI_CMD_USR);

    let status = await this.readRegister(SPI_W0_REG);
    // restore some SPI controller registers
    await this.writeRegister(SPI_USR_REG, oldSpiUsr);
    await this.writeRegister(SPI_USR2_REG, oldSpiUsr2);
    return status;
  }
  async detectFlashSize() {
    this.logger.log("Detecting Flash Size");

    let flashId = await this.flashId();
    let manufacturer = flashId & 0xff;
    let flashIdLowbyte = (flashId >> 16) & 0xff;

    this.logger.debug(`FlashId: ${toHex(flashId)}`);
    this.logger.log(`Flash Manufacturer: ${manufacturer.toString(16)}`);
    this.logger.log(
      `Flash Device: ${((flashId >> 8) & 0xff).toString(
        16
      )}${flashIdLowbyte.toString(16)}`
    );

    this.flashSize = DETECTED_FLASH_SIZES[flashIdLowbyte];
    this.logger.log(`Auto-detected Flash size: ${this.flashSize}`);
  }

  /**
   * @name getEraseSize
   * Calculate an erase size given a specific size in bytes.
   *   Provides a workaround for the bootloader erase bug on ESP8266.
   */
  getEraseSize(offset: number, size: number) {
    let sectorsPerBlock = 16;
    let sectorSize = FLASH_SECTOR_SIZE;
    let numSectors = Math.floor((size + sectorSize - 1) / sectorSize);
    let startSector = Math.floor(offset / sectorSize);

    let headSectors = sectorsPerBlock - (startSector % sectorsPerBlock);
    if (numSectors < headSectors) {
      headSectors = numSectors;
    }

    if (numSectors < 2 * headSectors) {
      return Math.floor(((numSectors + 1) / 2) * sectorSize);
    }

    return (numSectors - headSectors) * sectorSize;
  }

  /**
   * @name memBegin (592)
   * Start downloading an application image to RAM
   */
  async memBegin(
    size: number,
    blocks: number,
    blocksize: number,
    offset: number
  ) {
    return await this.checkCommand(
      ESP_MEM_BEGIN,
      pack("<IIII", size, blocks, blocksize, offset)
    );
  }

  /**
   * @name memBlock (609)
   * Send a block of an image to RAM
   */
  async memBlock(data: number[], seq: number) {
    return await this.checkCommand(
      ESP_MEM_DATA,
      pack("<IIII", data.length, seq, 0, 0).concat(data),
      this.checksum(data)
    );
  }

  /**
   * @name memFinish (615)
   * Leave download mode and run the application
   *
   * Sending ESP_MEM_END usually sends a correct response back, however sometimes
   * (with ROM loader) the executed code may reset the UART or change the baud rate
   * before the transmit FIFO is empty. So in these cases we set a short timeout and
   * ignore errors.
   */
  async memFinish(entrypoint = 0) {
    let timeout = this.IS_STUB ? DEFAULT_TIMEOUT : MEM_END_ROM_TIMEOUT;
    let data = pack("<II", entrypoint == 0 ? 1 : 0, entrypoint);
    // try {
    return await this.checkCommand(ESP_MEM_END, data, 0, timeout);
    // } catch (err) {
    //   console.error("Error in memFinish", err);
    //   if (this.IS_STUB) {
    //     //  raise
    //   }
    //   // pass
    // }
  }

  // ESPTool Line 706
  async runStub(): Promise<EspStubLoader> {
    const stub = await getStubCode(this.chipFamily);

    // We're transferring over USB, right?
    let ramBlock = USB_RAM_BLOCK;

    // Upload
    this.logger.log("Uploading stub...");
    for (let field of ["text", "data"]) {
      if (Object.keys(stub).includes(field)) {
        let offset = stub[field + "_start"];
        let length = stub[field].length;
        let blocks = Math.floor((length + ramBlock - 1) / ramBlock);
        await this.memBegin(length, blocks, ramBlock, offset);
        for (let seq of Array(blocks).keys()) {
          let fromOffs = seq * ramBlock;
          let toOffs = fromOffs + ramBlock;
          if (toOffs > length) {
            toOffs = length;
          }
          await this.memBlock(stub[field].slice(fromOffs, toOffs), seq);
        }
      }
    }
    this.logger.log("Running stub...");
    await this.memFinish(stub["entry"]);

    const p = await this.readBuffer(100);
    const pChar = String.fromCharCode(...p!);

    if (pChar != "OHAI") {
      throw new Error("Failed to start stub. Unexpected response: " + pChar);
    }
    this.logger.log("Stub is now running...");
    const espStubLoader = new EspStubLoader(this.port, this.logger, this);

    // Try to autodetect the flash size as soon as the stub is running.
    await espStubLoader.detectFlashSize();

    return espStubLoader;
  }

  async writeToStream(data: number[]) {
    const writer = this.port.writable!.getWriter();
    await writer.write(new Uint8Array(data));
    try {
      writer.releaseLock();
    } catch (err) {
      console.error("Ignoring release lock error", err);
    }
  }

  async disconnect() {
    if (this._parent) {
      await this._parent.disconnect();
      return;
    }
    if (this._reader) {
      await this._reader.cancel();
    }
    await this.port.writable!.getWriter().close();
    await this.port.close();
    this.connected = false;
  }
}

class EspStubLoader extends ESPLoader {
  /*
    The Stubloader has commands that run on the uploaded Stub Code in RAM
    rather than built in commands.
  */
  IS_STUB = true;

  /**
   * @name memBegin (592)
   * Start downloading an application image to RAM
   */
  async memBegin(
    size: number,
    blocks: number,
    blocksize: number,
    offset: number
  ): Promise<any> {
    let stub = await getStubCode(this.chipFamily);
    let load_start = offset;
    let load_end = offset + size;
    console.log(load_start, load_end);
    console.log(
      stub.data_start,
      stub.data.length,
      stub.text_start,
      stub.text.length
    );
    for (let [start, end] of [
      [stub.data_start, stub.data_start + stub.data.length],
      [stub.text_start, stub.text_start + stub.text.length],
    ]) {
      if (load_start < end && load_end > start) {
        throw new Error(
          "Software loader is resident at " +
            toHex(start, 8) +
            "-" +
            toHex(end, 8) +
            ". " +
            "Can't load binary at overlapping address range " +
            toHex(load_start, 8) +
            "-" +
            toHex(load_end, 8) +
            ". " +
            "Try changing the binary loading address."
        );
      }
    }
  }

  /**
   * @name getEraseSize
   * depending on flash chip model the erase may take this long (maybe longer!)
   */
  async eraseFlash() {
    await this.checkCommand(ESP_ERASE_FLASH, [], 0, CHIP_ERASE_TIMEOUT);
  }
}
