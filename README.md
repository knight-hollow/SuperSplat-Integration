# SuperSplat Editor

## Local Development

To initialize a local development environment for SuperSplat, ensure you have [Node.js](https://nodejs.org/) 18 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/knight-hollow/SuperSplat-Integration.git
   cd SuperSplat-Integration
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Build SuperSplat and start a local web server:

   ```sh
   npm run develop:vpcc:wasm
   ```

4. Open a web browser tab and make sure network caching is disabled on the network tab and the other application caches are clear:

   - On Safari you can use `Cmd+Option+e` or Develop->Empty Caches.
   - On Chrome ensure the options "Update on reload" and "Bypass for network" are enabled in the Application->Service workers tab:

   <img width="846" alt="Screenshot 2025-04-25 at 16 53 37" src="https://github.com/user-attachments/assets/888bac6c-25c1-4813-b5b6-4beecf437ac9" />

5. Navigate to `http://localhost:3000`

When changes to the source are detected, SuperSplat is rebuilt automatically. Simply refresh your browser to see your changes.

## GS4 Encoder Building

Clone the repository:

   ```sh
   git clone https://git.mpeg.expert/kondrad/mpeg-pcc-tmc2
   cd mpeg-pcc-tmc2
   git checkout PCCGSEncoder_decoder
   ```
Build the mpeg-pcc-tmc2 

### OSX
   ```sh
   mkdir build
   cd build
   cmake .. 
   cmake --build . --config Release --parallel 8
   ```

### Linux
   ```sh
   mkdir build
   cd build
   cmake .. 
   cmake --build . --config Release --parallel 8
   ```

### Windows
   ```sh
   md build
   cd build
   cmake .. 
   cmake --build . --config Release --parallel 8
   ```

### Encode
   ```sh
   ./bin/PccGs4AppEncoder.exe \
    --uncompressedDataPath=/path/to/ply_file.ply \
    --configurationFolder=./mpeg-pcc-tmc2/cfg/gs4// \
    --config=./mpeg-pcc-tmc2/cfg/gs4//gs-scc-common.cfg \
    --config=./mpeg-pcc-tmc2/cfg/gs4//gs-pack-none.cfg \
    --config=./mpeg-pcc-tmc2/cfg/gs4//rate/r02/encoder.cfg \
    --startFrameNumber=0000 \
    --frameCount=1 \
    --compressedStreamPath=/path/to/compressed_file.bin \
   ```
### Decode
   ```sh
   ./bin/PccAppDecoder.exe \
    --compressedStreamPath=/path/to/compressed_file.bin\
    --reconstructedDataPath=/path/to/Decode/frame_0000.decoded.ply \
    --computeMetrics=0 --computeChecksum=0 \
   ```