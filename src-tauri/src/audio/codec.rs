use opus::{Decoder, Encoder};
use super::AudioConfig;
use std::cell::RefCell;

pub trait AudioCodec {
    fn encode(&self, pcm_data: &[i16]) -> Result<Vec<u8>, String>;
    fn decode(&self, encoded_data: &[u8]) -> Result<Vec<i16>, String>;
}

pub struct OpusCodec {
    encoder: RefCell<Encoder>,
    decoder: RefCell<Decoder>,
    frame_size: usize,
    sample_rate: u32,
}

impl OpusCodec {
    pub fn new(config: &AudioConfig) -> Result<Self, String> {
        let encoder = Encoder::new(config.sample_rate, opus::Channels::Mono, opus::Application::Voip)
            .map_err(|e| format!("Failed to create Opus encoder: {}", e))?;

        let decoder = Decoder::new(config.sample_rate, opus::Channels::Mono)
            .map_err(|e| format!("Failed to create Opus decoder: {}", e))?;

        Ok(Self {
            encoder: RefCell::new(encoder),
            decoder: RefCell::new(decoder),
            frame_size: config.frame_size,
            sample_rate: config.sample_rate,
        })
    }

    pub fn get_frame_size(&self) -> usize {
        self.frame_size
    }

    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

impl AudioCodec for OpusCodec {
    /// Encode PCM audio to Opus format
    fn encode(&self, pcm_data: &[i16]) -> Result<Vec<u8>, String> {
        if pcm_data.len() != self.frame_size {
            return Err(format!(
                "Invalid frame size: expected {}, got {}",
                self.frame_size,
                pcm_data.len()
            ));
        }

        let mut encoder = self.encoder.borrow_mut();
        let mut output = vec![0u8; 4000]; // Max opus frame size
        let len = encoder
            .encode(pcm_data, &mut output)
            .map_err(|e| format!("Opus encoding failed: {}", e))?;

        output.truncate(len);
        Ok(output)
    }

    /// Decode Opus data back to PCM
    fn decode(&self, encoded_data: &[u8]) -> Result<Vec<i16>, String> {
        let mut decoder = self.decoder.borrow_mut();
        let mut output = vec![0i16; self.frame_size];
        let len = decoder
            .decode(encoded_data, &mut output, false)
            .map_err(|e| format!("Opus decoding failed: {}", e))?;

        output.truncate(len);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_opus_codec_creation() {
        let config = AudioConfig::default();
        let result = OpusCodec::new(&config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_opus_encode_decode() {
        let config = AudioConfig::default();
        let codec = OpusCodec::new(&config).unwrap();

        // Create test audio data
        let test_data = vec![0i16; config.frame_size];

        // Encode
        let encoded = codec.encode(&test_data).unwrap();
        assert!(!encoded.is_empty());

        // Decode
        let decoded = codec.decode(&encoded).unwrap();
        assert_eq!(decoded.len(), config.frame_size);
    }

    #[test]
    fn test_invalid_frame_size() {
        let config = AudioConfig::default();
        let codec = OpusCodec::new(&config).unwrap();

        let invalid_data = vec![0i16; config.frame_size + 100];
        let result = codec.encode(&invalid_data);
        assert!(result.is_err());
    }
}
