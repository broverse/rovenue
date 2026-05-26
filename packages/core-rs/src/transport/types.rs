use serde::de::DeserializeOwned;

pub struct HttpRequest<'a> {
    pub path: &'a str,
    pub user_scope: Option<&'a str>,
    pub etag: Option<&'a str>,
}

impl<'a> HttpRequest<'a> {
    pub fn new(path: &'a str) -> Self {
        Self { path, user_scope: None, etag: None }
    }
    pub fn user_scope(mut self, scope: &'a str) -> Self {
        self.user_scope = Some(scope);
        self
    }
    pub fn etag(mut self, etag: &'a str) -> Self {
        self.etag = Some(etag);
        self
    }
}

#[derive(Debug)]
pub struct HttpResponse<T> {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Option<T>,
}

#[allow(dead_code)]
pub(crate) fn _assert_deserialize<T: DeserializeOwned>() {}
