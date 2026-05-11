use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use std::sync::{Arc, Mutex};

pub struct AudioCapture {
    stream: Option<Stream>,
    buffer: Arc<Mutex<Vec<i16>>>,
    is_recording: Arc<Mutex<bool>>,
}

impl AudioCapture {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No input device available".to_string())?;

        let config = StreamConfig {
            channels,
            sample_rate,
            buffer_size: cpal::BufferSize::Default,
        };

        let buffer = Arc::new(Mutex::new(Vec::new()));
        let buffer_clone = buffer.clone();
        let is_recording = Arc::new(Mutex::new(false));
        let is_recording_clone = is_recording.clone();

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if *is_recording_clone.lock().unwrap() {
                        let mut buf = buffer_clone.lock().unwrap();
                        buf.extend_from_slice(data);
                    }
                },
                move |err| {
                    eprintln!("Audio capture error: {}", err);
                },
                None,
            )
            .map_err(|e| e.to_string())?;

        Ok(Self {
            stream: Some(stream),
            buffer,
            is_recording,
        })
    }

    /// Start recording
    pub fn start(&self) -> Result<(), String> {
        if let Some(stream) = &self.stream {
            *self.is_recording.lock().unwrap() = true;
            stream.play().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Stream not initialized".to_string())
        }
    }

    /// Stop recording
    pub fn stop(&self) -> Result<(), String> {
        *self.is_recording.lock().unwrap() = false;
        if let Some(stream) = &self.stream {
            stream.pause().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Stream not initialized".to_string())
        }
    }

    /// Get recorded audio samples
    pub fn get_samples(&self) -> Vec<i16> {
        let mut buf = self.buffer.lock().unwrap();
        let samples = buf.clone();
        buf.clear();
        samples
    }

    /// Get number of samples in buffer
    pub fn sample_count(&self) -> usize {
        self.buffer.lock().unwrap().len()
    }

    /// Check if currently recording
    pub fn is_recording(&self) -> bool {
        *self.is_recording.lock().unwrap()
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_capture_creation() {
        // This test will only work if audio devices are available
        let result = AudioCapture::new(48000, 1);
        // We don't assert success here because CI environments may not have audio
        let _ = result;
    }
}
